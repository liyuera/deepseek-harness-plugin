/**
 * Host half of `@liyuera/dsh-bug-workflow`.
 *
 * Task 2 wiring: prove the host can import the storage-domain package through
 * `peerDependencies`, open domain `bug_workflow`, and serve a minimal probe.
 *
 *   GET /bug-workflow/api/health -> { ok, domainOpenedAt, tickets }
 *
 * Task 3 turns this into the full `/bug-workflow/api/*` route set; it extends
 * the store/domain wiring started here instead of replacing it.
 *
 * Failure policy: `webServer` is the only hard dependency, so the plugin still
 * loads in a profile without storage. The domain is opened inside
 * `ctx.inject(['storageDomain'], ...)`; if the service is missing or the open
 * fails, `/health` answers HTTP 5xx with `{ ok: false, stage, error }` and the
 * failure is cached (domain.js) instead of being retried per request.
 */
import { closeDomain, openDomain } from './src/host/domain.js';
import { createStore } from './src/host/store.js';

export const inject = ['webServer'];

const HEALTH_ROUTE = '/bug-workflow/api/health';

export function apply(ctx) {
  // Shared state observed by the health route. `status` is one of
  // waiting-for-service | opening | open | failed.
  const health = {
    status: 'waiting-for-service',
    stage: 'storage-service',
    error: undefined,
    openedAt: undefined,
    domain: undefined,
    store: undefined,
  };

  let openPending;

  ctx.inject(['storageDomain'], (storageCtx) => {
    health.status = 'opening';
    health.stage = 'open-domain';

    openPending = (async () => {
      try {
        const handle = await openDomain(storageCtx);
        health.openedAt = handle.openedAt;
        health.domain = handle.domain;

        health.stage = 'create-store';
        health.store = createStore(handle.domain);

        health.status = 'open';
        health.stage = undefined;
        return handle;
      } catch (error) {
        health.status = 'failed';
        health.stage = typeof error?.stage === 'string' ? error.stage : 'open-domain';
        health.error = errorMessage(error);
        logFailure(storageCtx, error);
        throw error;
      }
    })();

    // No request may have observed the open yet; keep the rejection handled.
    openPending.catch(() => {});

    // The caller owns the domain handle: close it when this fiber is disposed
    // (plugin unload/reload). Awaiting the open also covers a close that races
    // a late successful open; `closeDomain` is idempotent.
    storageCtx.effect(
      () => async () => {
        const handle = await openPending.catch(() => undefined);
        if (handle !== undefined) await closeDomain(handle).catch(() => {});
      },
      'bug-workflow: bug_workflow domain lifetime',
    );
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: HEALTH_ROUTE,
        handler: (req, res) => handleHealth(health, req, res),
      }),
    'bug-workflow: health route',
  );
}

/**
 * Minimal live probe for the storage-domain wiring. Task 3 replaces the body
 * with the full snapshot/action/settings handlers.
 */
function handleHealth(health, req, res) {
  if (req.method !== 'GET') {
    sendJsonSafe(res, 405, {
      ok: false,
      code: 'method-not-allowed',
      message: 'health 仅支持 GET',
    });
    return;
  }

  if (health.status === 'open') {
    try {
      const tickets = health.store.list().length;
      sendJsonSafe(res, 200, {
        ok: true,
        domainOpenedAt: health.openedAt,
        tickets,
      });
    } catch (error) {
      sendJsonSafe(res, 500, {
        ok: false,
        stage: 'list-tickets',
        error: errorMessage(error),
      });
    }
    return;
  }

  const opening = health.status !== 'failed';
  sendJsonSafe(res, health.status === 'failed' ? 500 : 503, {
    ok: false,
    stage: health.stage,
    error: health.error ?? (opening
      ? 'storage domain 仍在打开'
      : 'ctx.storageDomain service unavailable'),
  });
}

/** A response writer that also survives a client that already disconnected. */
function sendJsonSafe(res, status, payload) {
  try {
    sendJson(res, status, payload);
  } catch {
    // Nothing is left to report to; the handler still must not throw.
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Diagnostics only; a failing logger must not mask the original error. */
function logFailure(context, error) {
  try {
    context.logger?.error?.('bug-workflow: storage domain 打开失败', error);
  } catch {
    // Ignore logger failures.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
