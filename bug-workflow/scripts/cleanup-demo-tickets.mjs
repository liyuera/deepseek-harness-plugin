#!/usr/bin/env node
/**
 * Remove leftover mock-platform tickets from a DSH `bug_workflow` storage file.
 *
 * P2 live acceptance synced/imported mock-platform tickets into the real
 * storage. Their `platform.url` points at a mock server that no longer exists,
 * so they are demo data, not real platform tickets. The board has no delete
 * action, and hand-editing `~/.dsh/storages/bug_workflow.json` is unsafe: the
 * host keeps the domain in memory and rewrites the file on the next write, so
 * an external edit is either overwritten or races a concurrent save.
 *
 * This script is the documented, guarded alternative. It only removes tickets
 * that are BOTH `source === 'platform'` AND whose platform URL is loopback
 * (`127.0.0.1` / `localhost` / `[::1]`), i.e. mock leftovers. A real platform
 * ticket can never be removed by accident. It validates the whole file before
 * touching it, copies a `0600` backup next to the original, writes the new
 * JSON to a `0600` temp file in the same directory, fsyncs it, re-parses it,
 * and only then atomically renames it over the original.
 *
 * IMPORTANT: quit DSH completely before using `--write`. The script cannot
 * detect a running host, and a running host will overwrite this file from its
 * in-memory domain. `--dry-run` (the default) is safe at any time.
 *
 * Usage:
 *   # 1) see what would be removed (no file changes):
 *   node bug-workflow/scripts/cleanup-demo-tickets.mjs \
 *     --codes YGFNXDJRFWDJSYJJYY-647,YGFNXDJRFWDJSYJJYY-648,HTSMART-12
 *
 *   # 2) after quitting DSH, remove them:
 *   node bug-workflow/scripts/cleanup-demo-tickets.mjs \
 *     --codes YGFNXDJRFWDJSYJJYY-647,YGFNXDJRFWDJSYJJYY-648,HTSMART-12 \
 *     --write
 *
 *   # optional: another profile/storage path
 *   node bug-workflow/scripts/cleanup-demo-tickets.mjs \
 *     --storage /path/to/bug_workflow.json --codes ... --write
 *
 * Action-idempotency rows in `meta` are left untouched. Rows that referred to a
 * removed ticket become orphans; the ledger is bounded (500 entries) and the
 * storage domain ignores unknown keys, so they are harmless.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = [
  'usage: node bug-workflow/scripts/cleanup-demo-tickets.mjs --codes <CODE[,CODE…]> [options]',
  '',
  '  --codes <list>     comma-separated ticket codes to remove (required)',
  '  --storage <path>   bug_workflow storage file',
  '                     (default: ~/.dsh/storages/bug_workflow.json)',
  '  --write            apply the change (default: dry-run, no file changes)',
  '  --help             print this help',
  '',
  'Only `source:"platform"` tickets whose platform URL is loopback are eligible.',
  'Quit DSH before --write: a running host overwrites external edits.',
].join('\n');

const DEFAULT_STORAGE = path.join(
  process.env.HOME ?? '',
  '.dsh',
  'storages',
  'bug_workflow.json',
);

/** Loopback host names used by the local mock platform. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Parse CLI arguments; exported shape is plain JSON for easy manual use. */
export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('parseArgs(argv) requires an array');
  const options = { storage: DEFAULT_STORAGE, codes: [], write: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--write') {
      options.write = true;
      continue;
    }
    if (flag !== '--codes' && flag !== '--storage') {
      throw new Error(`unknown argument: ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--storage') {
      if (value.trim() === '') throw new Error('--storage must be a non-empty path');
      options.storage = value;
    } else {
      for (const code of value.split(',')) {
        const trimmed = code.trim();
        if (trimmed !== '') options.codes.push(trimmed);
      }
    }
  }

  options.codes = [...new Set(options.codes)];
  return options;
}

/** Read + validate the storage envelope. Throws on anything suspicious. */
export function readStorage(storagePath) {
  const text = readFileSync(storagePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`storage is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('storage root must be a JSON object');
  }
  if (parsed.unit?.name !== 'bug_workflow') {
    throw new Error(`unexpected domain unit ${JSON.stringify(parsed.unit?.name)} (want "bug_workflow")`);
  }
  if (!Number.isInteger(parsed.unit?.version) || parsed.unit.version < 1) {
    throw new Error('storage unit.version must be a positive integer');
  }
  if (parsed.tables === null || typeof parsed.tables !== 'object' || Array.isArray(parsed.tables)) {
    throw new Error('storage tables must be an object');
  }
  if (
    parsed.tables.tickets === null
    || typeof parsed.tables.tickets !== 'object'
    || Array.isArray(parsed.tables.tickets)
  ) {
    throw new Error('storage tables.tickets must be an object');
  }
  return parsed;
}

/** Why a ticket is not eligible for cleanup, or null when it is. */
export function ineligibleReason(ticket) {
  if (ticket === null || typeof ticket !== 'object' || Array.isArray(ticket)) {
    return 'ticket record is not an object';
  }
  if (ticket.source !== 'platform') return 'source is not "platform"';
  const url = ticket.platform?.url;
  if (typeof url !== 'string' || url.trim() === '') return 'platform.url is missing';
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return 'platform.url is not a valid URL';
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return 'platform.url is not http(s)';
  }
  if (!LOOPBACK_HOSTS.has(parsedUrl.hostname)) {
    return `platform.url host "${parsedUrl.hostname}" is not loopback`;
  }
  return null;
}

/**
 * Plan the cleanup without writing. Returns `{ removable, refused, missing }`
 * where each entry is `{ code, reason? }`.
 */
export function planCleanup(storage, codes) {
  const tickets = storage.tables.tickets;
  const removable = [];
  const refused = [];
  const missing = [];
  for (const code of codes) {
    if (!Object.prototype.hasOwnProperty.call(tickets, code)) {
      missing.push({ code });
      continue;
    }
    const reason = ineligibleReason(tickets[code]);
    if (reason !== null) {
      refused.push({ code, reason });
    } else {
      removable.push({ code });
    }
  }
  return { removable, refused, missing };
}

/** Apply the removal in memory (mutates a copy owned by the caller). */
export function removeTickets(storage, codes) {
  for (const code of codes) delete storage.tables.tickets[code];
  return storage;
}

function timestampForBackup() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Write JSON atomically: 0600 temp in the same dir -> fsync -> re-parse -> rename. */
export function writeStorageAtomic(storagePath, storage) {
  const directory = path.dirname(storagePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(storagePath)}.tmp-${process.pid}-${Date.now()}`,
  );
  const body = `${JSON.stringify(storage, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tempPath, 0o600);
    // Fail loudly before the rename if the serialized file is unreadable.
    const parsed = JSON.parse(readFileSync(tempPath, 'utf8'));
    if (parsed?.unit?.name !== 'bug_workflow') {
      throw new Error('temp file round-trip lost the bug_workflow unit');
    }
    renameSync(tempPath, storagePath);
    chmodSync(storagePath, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort.
      }
    }
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function main(argv) {
  let options;

  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`cleanup-demo-tickets: ${error.message}`);
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.codes.length === 0) {
    console.error('cleanup-demo-tickets: --codes is required');
    console.error(USAGE);
    return 2;
  }

  const storagePath = path.resolve(options.storage);
  if (!existsSync(storagePath)) {
    console.error(`cleanup-demo-tickets: storage not found: ${storagePath}`);
    return 1;
  }

  let storage;
  try {
    storage = readStorage(storagePath);
  } catch (error) {
    console.error(`cleanup-demo-tickets: ${error.message}`);
    console.error('Refusing to touch the file.');
    return 1;
  }

  const { removable, refused, missing } = planCleanup(storage, options.codes);
  const totalTickets = Object.keys(storage.tables.tickets).length;

  console.log(`storage: ${storagePath}`);
  console.log(`tickets: ${totalTickets} total`);
  for (const { code } of removable) {
    const url = storage.tables.tickets[code].platform.url;
    console.log(`  remove  ${code}  (mock url: ${url})`);
  }
  for (const { code, reason } of refused) {
    console.log(`  REFUSE  ${code}  (${reason})`);
  }
  for (const { code } of missing) {
    console.log(`  MISSING ${code}`);
  }

  if (refused.length > 0) {
    console.error('Refusing to write: at least one selected ticket is not a mock-platform leftover.');
    return 1;
  }
  if (missing.length > 0) {
    console.error('Refusing to write: at least one selected ticket does not exist.');
    return 1;
  }
  if (removable.length === 0) {
    console.error('Nothing to remove.');
    return 1;
  }

  if (!options.write) {
    console.log('');
    console.log(`DRY RUN: ${removable.length} ticket(s) would be removed; no file changed.`);
    console.log('Quit DSH completely, then re-run with --write.');
    return 0;
  }

  const mode = statSync(storagePath).mode & 0o777;
  const backupPath = `${storagePath}.bak-${timestampForBackup()}`;
  copyFileSync(storagePath, backupPath);
  chmodSync(backupPath, 0o600);

  const next = removeTickets(structuredClone(storage), removable.map(({ code }) => code));
  const removedCodes = removable.map(({ code }) => code);
  try {
    writeStorageAtomic(storagePath, next);
  } catch (error) {
    console.error(`cleanup-demo-tickets: write failed: ${error.message}`);
    console.error(`Original file untouched; backup: ${backupPath}`);
    return 1;
  }

  const check = readStorage(storagePath);
  const remaining = Object.keys(check.tables.tickets);
  const leftover = removedCodes.filter((code) => remaining.includes(code));
  if (leftover.length > 0) {
    console.error(`cleanup-demo-tickets: verification failed, still present: ${leftover.join(', ')}`);
    console.error(`Original file untouched; backup: ${backupPath}`);
    return 1;
  }

  console.log('');
  console.log(`Removed ${removedCodes.length} ticket(s): ${removedCodes.join(', ')}`);
  console.log(`tickets: ${remaining.length} remaining (was ${totalTickets})`);
  console.log(`backup:  ${backupPath}`);
  console.log(`mode:    ${(statSync(storagePath).mode & 0o777).toString(8)} (was ${mode.toString(8)})`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
