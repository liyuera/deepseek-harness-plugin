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
 *   GET  /bug-workflow/api/snapshot  -> { ok, workspace, settings, platform, gitlab, dicts, analysis, fix, delivery, review, tickets, serverTime }
 *   POST /bug-workflow/api/action    -> { ok, ticket } | { ok:false, code, message, ticket? }
 *                                       (create + payload.code = 按编号从平台导入)
 *   POST /bug-workflow/api/analyze   -> { ok, workflow:'analyzing', running }
 *                                       (P3 real analysis; see below)
 *   POST /bug-workflow/api/fix       -> { ok, workflow:'fixing', running }
 *                                       (P4 real fix; see below)
 *   POST /bug-workflow/api/deliver   -> { ok, workflow:'submitting', running }
 *                                       (P5 delivery: lint/test → commit → push → MR)
 *   POST /bug-workflow/api/settings  -> { ok, settings }
 *   POST /bug-workflow/api/platform-login/captcha -> { ok, key, image }
 *   POST /bug-workflow/api/platform-login  -> { ok, tokenPresent, username }
 *                                       (P6 in-board login: account + password +
 *                                        image captcha; token is write-only)
 *   POST /bug-workflow/api/platform-token -> { ok, tokenPresent }
 *   POST /bug-workflow/api/gitlab-token   -> { ok, tokenPresent } (P5 GitLab token)
 *   POST /bug-workflow/api/sync      -> { ok, synced, created, updated, total, filtered, lastSyncAt }
 *
 * Analysis wiring (P3 Task 2): one `createAgentRunner()` per fiber resolves the
 * optional `subagents`/`agents` services through `ctx.get`, and
 * `createAnalysisService()` orchestrates the ticket transitions/errors over the
 * opened store. The runner is built even when those services are absent: it
 * reports `available() === false`, so `/analyze` answers 503 `analysis-unavailable`
 * instead of failing the whole plugin. The service is disposed and drained
 * (cancelled jobs are marked so they write no false failure; the drain is
 * bounded) before the storage domain closes; a stuck runner cannot hang unload.
 *
 * Fix wiring (P4 Task 2): `createGit()` provides the injected git executor
 * (default `execFile`), and `createFixService()` owns branch/worktree
 * preparation plus the write-capable fix subagent. It shares the same runner,
 * store and clock. Construction is non-fatal (the board still loads, `/fix`
 * answers 503 and the snapshot reports an empty `fix` block), and teardown
 * disposes/drains it together with the analysis service before the domain
 * closes.
 *
 * Delivery wiring (P5 Task 3): `createDeliveryService()` owns lint/test →
 * commit → push → MR over the same store/git/clock and the GitLab token store
 * from Task 1. The GitLab HTTP client is built PER WORKSPACE inside the
 * service (`gitlabClientFor(settings)`), because `gitlabBaseUrl` is a
 * per-workspace setting and `createGitlabClient` binds its base URL at
 * construction; a per-request factory is the Task 2 review M4 contract (a
 * single pre-built client would ignore later settings changes). Construction
 * is non-fatal (the board still loads, `/deliver` answers 503 and the snapshot
 * reports an empty `delivery` block), and teardown disposes/drains delivery
 * alongside analysis/fix before the domain closes.
 *
 * Review wiring (P5 Task 4b): `createReviewService()` owns the 60 s AI Review
 * poll, the review-fix job and merge/auto-archive. It is timer-driven (no HTTP
 * route): `readTimer(storageCtx)` is read optionally, and an absent timer only
 * disables polling (logged), never the board. It consumes the
 * `delivery.context:<code>` meta written by delivery (the timer has no live
 * session/workspace), reads the newest AI note, and shares the ONE
 * `createRepoLock()` instance with delivery (`review:<code>` vs
 * `delivery:<code>`), so git-writing jobs on one repository serialize.
 * Construction is non-fatal (the snapshot `review` block stays empty), and
 * teardown disposes/drains review BEFORE analysis/fix/delivery and before the
 * domain closes.
 *
 * Sync wiring (P2 Task 4): `createSyncService()` reads the token from
 * `ctx.credentials`, maps platform tasks into the v2 ticket store, and persists
 * the dictionaries/last-sync status in `meta`. `ctx.interval(600_000)` runs it
 * for the most recently created live session cwd, but only while a token is
 * present; every failure is captured in `meta['platform.lastSyncError']` and
 * never thrown out of the timer.
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
import { createAgentRunner } from './src/host/agent-access.js';
import { createAnalysisService } from './src/host/analysis-service.js';
import {
  createDeliveryService,
  createRepoLock,
  createShellExecCommand,
} from './src/host/delivery-service.js';
import { createFixService } from './src/host/fix-service.js';
import { createGit } from './src/host/git.js';
import { createGitlabClient } from './src/host/gitlab.js';
import { createTokenStore, GITLAB_TOKEN_REF } from './src/host/credentials.js';
import { createPlatformClient } from './src/host/platform.js';
import { createPlatformLogin } from './src/host/platform-login.js';
import { createReviewService } from './src/host/review-service.js';
import {
  registerRoutes,
  registerUnavailableRoutes,
} from './src/host/routes.js';
import { createStore } from './src/host/store.js';
import { createSyncService } from './src/host/sync.js';
import { resolveWorkspace } from './src/host/workspace.js';

export const inject = ['webServer'];

/** Periodic platform sync interval (10 minutes). */
export const AUTO_SYNC_INTERVAL_MS = 600_000;

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
  // Created after the store is ready; read by the domain-lifetime disposer so
  // running analyses/fixes are aborted before the storage domain closes.
  let analysisService;
  let fixService;
  let deliveryService;
  let reviewService;

  // One runner per fiber. Resolving the optional delegation services lazily via
  // `ctx.get` keeps the plugin loadable in profiles without subagents/agents:
  // the runner then reports `available() === false` and `/analyze` answers 503.
  const runner = createAgentRunner({
    services: { get: (name) => readService(ctx, name) },
  });

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
        // One lookup backs both token stores (platform + GitLab).
        const credentials = readCredentials(storageCtx);
        const tokenStore = createTokenStore(credentials);
        // P5: the GitLab token is a second, independent reference over the same
        // optional credentials service. The token value never leaves it; the
        // routes only read presence for the snapshot.
        const gitlabTokenStore = createTokenStore(
          credentials,
          { ref: GITLAB_TOKEN_REF },
        );

        // Sync engine: token from credentials, platform client over the
        // workspace's `platformBaseUrl`. `createPlatformClient` throws for an
        // invalid baseUrl; the sync service catches that (invalid config) and
        // never lets it reach the routes/timer.
        const sync = createSyncService({
          store,
          tokenStore,
          getSettings: (cwd) => store.getSettings(cwd),
          platformClientFor: (settings, token) => createPlatformClient({
            baseUrl: settings.platformBaseUrl,
            token,
          }),
          clock,
        });

        // P3 analysis orchestration. A construction failure must not take the
        // board down: the routes stay mounted, `/analyze` answers 503, and the
        // snapshot reports an empty analysis block.
        let analysis = null;
        try {
          // The 10-minute analysis budget is a code-level default in
          // analysis-service.js; P3 exposes no host setting for it. Pass
          // `{ timeoutMs }` here to change it.
          analysisService = createAnalysisService({ store, runner, clock });
          analysis = { service: analysisService };
        } catch (error) {
          analysisService = undefined;
          logWarning(storageCtx, 'bug-workflow: 分析服务初始化失败', error);
        }

        // P4 fix orchestration. Same non-fatal policy: a broken git executor or
        // service construction leaves `/fix` at 503 and the snapshot `fix`
        // block empty instead of taking the board/analysis down.
        //
        // The git executor is shared with the P5 delivery service, so it is
        // built once and a construction failure disables both features only.
        let gitExecutor = null;
        try {
          gitExecutor = createGit();
        } catch (error) {
          logWarning(storageCtx, 'bug-workflow: git 执行器初始化失败', error);
        }

        let fix = null;
        try {
          if (gitExecutor === null) throw new Error('git executor unavailable');
          fixService = createFixService({
            store,
            runner,
            git: gitExecutor,
            getSettings: (cwd) => store.getSettings(cwd),
            clock,
          });
          fix = { service: fixService };
        } catch (error) {
          fixService = undefined;
          logWarning(storageCtx, 'bug-workflow: 修复服务初始化失败', error);
        }

        // P5 delivery/review shared wiring. The GitLab client is built per
        // workspace from the CURRENT settings (`gitlabBaseUrl` is per-workspace
        // and the client binds it at construction); the factory is called inside
        // the services, which map construction errors to static failures
        // instead of failing the plugin load.
        const gitlabClientFor = (settings) => createGitlabClient({
          baseUrl: settings.gitlabBaseUrl,
          tokenProvider: () => gitlabTokenStore.get(),
        });
        // One repository single-flight lock shared by delivery and the review
        // fix job: owner `delivery:<code>` vs `review:<code>` on the same repo
        // are mutually exclusive, so two git-writing jobs can never overlap.
        const repoLock = createRepoLock();

        let delivery = null;
        try {
          if (gitExecutor === null) throw new Error('git executor unavailable');
          deliveryService = createDeliveryService({
            store,
            git: gitExecutor,
            tokenStore: gitlabTokenStore,
            gitlabClientFor,
            clock,
            lock: repoLock,
            execCommand: createShellExecCommand(),
          });
          delivery = { service: deliveryService };
        } catch (error) {
          deliveryService = undefined;
          logWarning(storageCtx, 'bug-workflow: 交付服务初始化失败', error);
        }

        // P5 AI Review polling + review-fix + merge/auto-archive. Timer-driven
        // (no HTTP route), constructed non-fatally: a broken construction leaves
        // the snapshot `review` block empty and the timer off, while delivery/
        // fix/analysis keep working. `readTimer()` is optional — an absent timer
        // service disables polling only (never the board).
        try {
          if (gitExecutor === null) throw new Error('git executor unavailable');
          reviewService = createReviewService({
            store,
            git: gitExecutor,
            runner,
            tokenStore: gitlabTokenStore,
            gitlabClientFor,
            clock,
            lock: repoLock,
            getSettings: (cwd) => store.getSettings(cwd),
            log: (entry) => logWarning(
              storageCtx,
              `bug-workflow: Review ${entry?.event ?? 'tick'} 失败`,
              entry?.error,
            ),
          });
        } catch (error) {
          reviewService = undefined;
          logWarning(storageCtx, 'bug-workflow: Review 服务初始化失败', error);
        }
        let review = reviewService === undefined ? null : { service: reviewService };
        if (review !== null) {
          const timer = readTimer(storageCtx);
          if (timer === null) {
            logWarning(storageCtx, 'bug-workflow: timer service unavailable, review polling disabled');
          } else {
            try {
              reviewService.start(timer);
            } catch (error) {
              // A broken timer service only disables polling; the snapshot
              // `review` block (status/errors) still works.
              logWarning(storageCtx, 'bug-workflow: Review 轮询启动失败', error);
            }
          }
        }

        // P6 in-board platform login (account + password + image captcha).
        // Construction is non-fatal: without it both login routes answer 503
        // and the token-paste fallback keeps the platform integration usable.
        let platformLogin = null;
        try {
          platformLogin = { service: createPlatformLogin() };
        } catch (error) {
          platformLogin = null;
          logWarning(storageCtx, 'bug-workflow: 平台登录服务初始化失败', error);
        }

        // Automatic sync is registered BEFORE the real routes are mounted: if
        // the optional timer service misbehaves, the catch path still owns the
        // fallback route set (never real handlers over a closed domain).
        registerAutoSync(storageCtx, sync);

        stage = 'register-routes';
        health.stage = stage;
        const mounted = mountApi(() => registerRoutes(ctx, {
          store,
          workspace,
          tokenStore,
          gitlabTokenStore,
          sync,
          // By-code import shares the sync service's token/settings/platform
          // client wiring. Guarding the method keeps an older/sync-less build
          // on the route's 503 storage-unavailable path instead of throwing.
          importTask: typeof sync.importTask === 'function'
            ? (cwd, code) => sync.importTask(cwd, code)
            : null,
          analysis,
          fix,
          delivery,
          review,
          platformLogin,
          clock,
          domainOpenedAt: handle.openedAt,
          // Full request errors stay in the host log; only clipped summaries
          // reach an HTTP response.
          log: (entry) => logRequestFailure(storageCtx, entry),
        }));

        if (!mounted) {
          // The fiber was disposed while the domain was opening; no request can
          // reach these handlers any more, so release the domain immediately
          // instead of leaving a handle behind. Drain any review/analysis/fix/
          // delivery job before closing the domain so an in-flight job write
          // cannot land on it (the review poller uses the same repo lock as
          // delivery, so it is stopped first).
          await reviewService?.dispose();
          await analysisService?.dispose();
          await fixService?.dispose();
          await deliveryService?.dispose();
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
        // every reload. Abort and drain any review/analysis/fix/delivery job
        // first; it may still write through the store.
        try {
          await reviewService?.dispose();
        } catch {
          // Teardown must continue regardless.
        }
        try {
          await analysisService?.dispose();
        } catch {
          // Teardown must continue regardless.
        }
        try {
          await fixService?.dispose();
        } catch {
          // Teardown must continue regardless.
        }
        try {
          await deliveryService?.dispose();
        } catch {
          // Teardown must continue regardless.
        }
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
        // Abort and drain running services first: their background jobs may
        // still write through the store, and the domain must not close under a
        // live job. The review poller is stopped first (it shares the repo lock
        // with delivery). Every drain is bounded, so a stuck runner/command
        // cannot hang unload.
        try {
          await reviewService?.dispose();
        } catch {
          // Disposal is best-effort; the domain teardown still has to run.
        }
        try {
          await analysisService?.dispose();
        } catch {
          // Disposal is best-effort; the domain teardown still has to run.
        }
        try {
          await fixService?.dispose();
        } catch {
          // Disposal is best-effort; the domain teardown still has to run.
        }
        try {
          await deliveryService?.dispose();
        } catch {
          // Disposal is best-effort; the domain teardown still has to run.
        }
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

/**
 * Optional Cordis service lookup (`ctx.get(name)`). A missing or throwing
 * registry yields undefined instead of rejecting: optional services only
 * degrade a feature, they never take the plugin down.
 */
function readService(context, name) {
  try {
    if (typeof context?.get === 'function') return context.get(name);
    return undefined;
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

/** Diagnostics only: non-fatal wiring degradation (never thrown). */
function logWarning(context, message, error) {
  try {
    context.logger?.warn?.(message, error);
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

/**
 * Register the 10-minute auto-sync tick.
 *
 * `timer` is read optionally (`ctx.get('timer')`) rather than injected: an
 * absent timer service only disables auto-sync, it must not hold back the
 * storage routes. The service's `interval(callback, delay)` returns a disposer;
 * wrapping it in `ctx.effect` ties it to this fiber.
 */
function registerAutoSync(context, syncService) {
  const timer = readTimer(context);
  if (timer === null) {
    try {
      context?.logger?.warn?.('bug-workflow: timer service unavailable, auto-sync disabled');
    } catch {
      // Diagnostics only.
    }
    return;
  }

  context.effect(
    () => timer.interval(() => {
      void runAutoSync(context, syncService);
    }, AUTO_SYNC_INTERVAL_MS),
    'bug-workflow: platform auto-sync',
  );
}

/**
 * Optional `timer` service lookup. Accessing `context.interval` directly throws
 * "cannot get property \"timer\" without inject" on this runtime, so the
 * documented optional service access is used instead.
 */
function readTimer(context) {
  try {
    const timer = typeof context?.get === 'function' ? context.get('timer') : undefined;
    if (timer !== null && typeof timer === 'object' && typeof timer.interval === 'function') {
      return timer;
    }
  } catch {
    // An unavailable/broken timer service only disables auto-sync.
  }
  return null;
}

/**
 * One auto-sync tick. Skips silently when no token is configured or no live
 * session exposes a cwd; `syncService.run()` itself returns a structured
 * failure (also persisted in meta), so nothing is ever thrown to the timer.
 */
async function runAutoSync(context, syncService) {
  try {
    const status = await syncService.status();
    if (status?.tokenPresent !== true) return;

    const cwd = latestLiveCwd(context.sessions);
    if (cwd === null) return;

    await syncService.run(cwd);
  } catch (error) {
    try {
      context.logger?.warn?.('bug-workflow: 自动同步失败', error);
    } catch {
      // Diagnostics only: a broken logger must not reject the timer.
    }
  }
}

/**
 * cwd of the most recently created live session that carries one. Sessions are
 * listed in creation order, so the newest session is the "last known" target;
 * no live session means there is nothing to sync for.
 */
function latestLiveCwd(sessions) {
  try {
    if (sessions === null || typeof sessions !== 'object' || typeof sessions.list !== 'function') {
      return null;
    }
    const list = sessions.list();
    if (!Array.isArray(list)) return null;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const cwd = list[index]?.header?.cwd;
      if (typeof cwd === 'string' && cwd.trim() !== '') return cwd;
    }
  } catch {
    // A failing session store must not break the timer.
  }
  return null;
}
