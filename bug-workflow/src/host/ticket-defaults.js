/**
 * Dependency-free Ticket platform defaults for domain v2.
 *
 * The Ticket record gained two fields in domain v2:
 *
 *   source    'platform' | 'manual'  — who created the ticket
 *   platform  null | PlatformRecord  — synced platform snapshot (see domain.js)
 *
 * The zod schema in `domain.js` declares matching `.default()`s, so a v1 record
 * loaded from disk is normalized at domain open. This module is the write-side
 * half used by `store.create()`: it fills the same defaults before validation
 * and persistence so a freshly created manual ticket is stored with explicit
 * `source:'manual'` / `platform:null` rather than relying on a later reload.
 *
 * It stays free of zod/the storage-domain package on purpose: the unit tests
 * run under plain Node and cannot resolve those bare imports. `null`/`undefined`
 * fields count as absent (`??`), so the function is idempotent and preserves
 * any real `source`/`platform` recorded by a future platform sync.
 *
 * @param {object} ticket a Ticket-like object (`initialTicket()` output)
 * @returns {object} a new ticket with the two defaults applied; other fields are
 *   copied by reference and never mutated. Non-object input is returned as-is
 *   for the caller's schema to reject.
 */
export function withPlatformDefaults(ticket) {
  if (ticket === null || typeof ticket !== 'object' || Array.isArray(ticket)) {
    return ticket;
  }

  return {
    ...ticket,
    source: ticket.source ?? 'manual',
    platform: ticket.platform ?? null,
  };
}
