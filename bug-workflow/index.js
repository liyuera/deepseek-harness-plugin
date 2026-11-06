/**
 * Host half of `@liyuera/dsh-bug-workflow`.
 *
 * Wiring:
 *
 *   apply()
 *     -> mount fallback /bug-workflow/api/* routes (health reports the stage)
 *     -> ctx.inject(['storageDomain','sessions'])
 *          -> openDomain() -> createStore(domain, schemas) -> registerRoutes()
 *          -> swap the fallback routes for the real handlers
 *          -> close the domain from the fiber disposer
 *
 *   GET  /bug-workflow/api/health    -> { ok, domainOpenedAt, tickets }
 *   GET  /bug-workflow/api/snapshot  -> { ok, workspace, settings, platform, tickets, serverTime }
 *   POST /bug-workflow/api/action    -> { ok, ticket } | { ok:false, code, message, ticket? }
 *   POST /bug-workflow/api/settings  -> { ok, settings }
 *   POST /bug-workflow/api/platform-token -> { ok, tokenPresent }
 *
 * Failure policy: `webServer` is the only hard dependency, so the plugin still
 * loads in a profile without storage. The `credentials` service is read
 * optionally (`ctx.get('credentials')`) instead of injected: if it were a hard
 * injection, an absent credentials service would hold back the storage routes
 * too, leaving the board with no snapshot at all. Without credentials the
 * plugin still loads, the snapshot reports `platform.tokenPresent:false`, and
 * the token route answers 503 `credentials-unavailable`. The fallback routes
 * stay mounted until the real handlers are ready: `/health` answers HTTP 500
 * with `{ ok:false, stage:'storage-service' }` when the inject never ran, 503 while
 * opening, and 500 with the failing stage after an open/create-store/register
 * error; the data routes answer 503. An open failure is cached by domain.js
 * instead of retried per request, and the per-fiber cache key is the inject
 * child context (never the facility singleton — see Task 2 concern #1).
 *
 * The web server rejects duplicate exact paths, so routes are never registered
 * twice: the fallback is disposed immediately before the real set is mounted.
 * Both sets are removed by the `apply` fiber disposer.
 */
import { closeDomain, openDomain, settingsSchema, ticketSchema } from './src/host/domain.js';
import { createTokenStore } from './src/host/credentials.js';
import {
  registerRoutes,
  registerUnavailableRoutes,
} from './src/host/routes.js';
import { createStore } from './src/host/store.js';
import { resolveWorkspace } from './src/host/workspace.js';

export const inject = ['webServer'];

/**
 * Write-boundary validators handed to the store. These are the domain's real
 * zod schemas (the same `parse` the storage layer runs on open), so the store
 * cannot persist a state-machine output that would fail loud on the next
 * reload and make the domain/board unopenable.
 */
const validateTicket = (ticket) => ticketSchema.parse(ticket);
const validateSettings = (settings) => settingsSchema.parse(settings);

const clock = () => new Date().toISOString();

export function apply(ctx) {
  // Shared state observed by the fallback health route. `status` is one of
  // waiting-for-service | opening | open | failed.
  const health = {
    status: 'waiting-for-service',
    stage: 'storage-service',
    error: 'ctx.storageDomain / ctx.sessions service unavailable',
  };

  let openPending;
  let disposeApi;
  let disposed = false;

  /**
   * Replace the mounted route set. The old set is disposed first because the
   * web server forbids duplicate `(kind, path)` registrations. Returns false
   * when the fiber is already disposed, in which case the caller must not
   * register anything.
   */
  const mountApi = (register) => {
    if (disposed) return false;
    const previous = disposeApi;
    disposeApi = undefined;
    previous?.();
    disposeApi = register();
    return true;
  };

  // Health (and inert 503 data routes) exist from the first moment the plugin
  // loads, so a board poll never gets a 404 while storage is still opening.
  mountApi(() => registerUnavailableRoutes(ctx, health));

  ctx.effect(
    () => () => {
      disposed = true;
      const dispose = disposeApi;
      disposeApi = undefined;
      dispose?.();
    },
    'bug-workflow: api routes',
  );

  ctx.inject(['storageDomain', 'sessions'], (storageCtx) => {
    health.status = 'opening';
    health.stage = 'open-domain';
    health.error = undefined;

    openPending = (async () => {
      let handle;
      let stage = 'open-domain';
      try {
        handle = await openDomain(storageCtx);

        stage = 'create-store';
        health.stage = stage;
        const store = createStore(handle.domain, undefined, {
          validateTicket,
          validateSettings,
        });

        // Workspace settings are keyed by the live session header cwd. P1
        // `configured` only means the session resolved to a directory; Task 5
        // adds the explicit "has saved settings" check.
        const workspace = {
          resolve: (sessionId) => resolveWorkspace(
            { sessions: storageCtx.sessions },
            sessionId,
          ),
        };

        // `credentials` is read optionally rather than injected: hardening the
        // storage routes must not depend on a service the board can live
        // without. Absent credentials -> tokenPresent:false + 503 on writes.
        const tokenStore = createTokenStore(readCredentials(storageCtx));

        stage = 'register-routes';
        health.stage = stage;
        const mounted = mountApi(() => registerRoutes(ctx, {
          store,
          workspace,
          tokenStore,
          clock,
          domainOpenedAt: handle.openedAt,
          // Full request errors stay in the host log; only clipped summaries
          // reach an HTTP response.
          log: (entry) => logRequestFailure(storageCtx, entry),
        }));

        if (!mounted) {
          // The fiber was disposed while the domain was opening; no request can
          // reach these handlers any more, so release the domain immediately
          // instead of leaving a handle behind.
          await closeDomain(handle);
          return handle;
        }

        health.status = 'open';
        health.stage = undefined;
        health.error = undefined;
        return handle;
      } catch (error) {
        // Release a domain that opened but could not be attached to a store (or
        // to routes); otherwise the facility would report `already-open` on
        // every reload.
        if (handle !== undefined) await closeDomain(handle).catch(() => {});
        health.status = 'failed';
        health.stage = typeof error?.stage === 'string' ? error.stage : stage;
        health.error = errorMessage(error);

        // A failed route swap has already disposed the fallback. Restore it so
        // health still reports the failure instead of disappearing; if the
        // fallback survived, leave it alone.
        if (disposeApi === undefined && !disposed) {
          try {
            mountApi(() => registerUnavailableRoutes(ctx, health));
          } catch {
            // The web server itself is tearing down; nothing left to serve.
          }
        }

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
}

/**
 * Optional service read: `credentials` is not a hard dependency of the board.
 * `ctx.get()` is the seam's documented optional access; a context without the
 * service returns undefined, which the token store reports as unavailable.
 */
function readCredentials(context) {
  try {
    if (typeof context?.get === 'function') return context.get('credentials');
    return context?.credentials;
  } catch {
    return undefined;
  }
}

/** Diagnostics only; a failing logger must not mask the original error. */
function logFailure(context, error) {
  try {
    context.logger?.error?.('bug-workflow: 存储域装配失败', error);
  } catch {
    // Ignore logger failures.
  }
}

/** Diagnostics only: request errors are clipped before leaving the host. */
function logRequestFailure(context, entry) {
  try {
    context.logger?.warn?.(`bug-workflow: 请求处理失败 (${entry?.event ?? 'internal'})`, entry?.error);
  } catch {
    // Ignore logger failures.
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
