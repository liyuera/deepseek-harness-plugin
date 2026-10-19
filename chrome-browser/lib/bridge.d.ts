/**
 * Lifecycle of this plugin's own fixed-port extension bridge.
 *
 * The shipped Chrome extension dials a fixed loopback port and cannot discover
 * another one. Older dsh builds served that port themselves; the desktop client
 * now asks the OS for a free web port (`--port 0`), so the plugin serves the
 * extension-facing routes on its own server. When the dsh web server already
 * listens on the bridge port, its own registration IS the bridge and no second
 * listener starts.
 * @module @liyuera/dsh-chrome-browser/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BrowserBackend } from './backend.ts';
import type { BridgeReport } from './routes.ts';
/**
 * Start the plugin's own bridge server when the dsh web server does not already
 * listen on the port the extension dials.
 * @param ctx - Cordis context; its `webServer` port decides whether the dsh
 *   server is already the bridge.
 * @param backend - live browser backend the bridge routes drive.
 * @param screenshotDir - directory the bridge's screenshot upload route writes to.
 * @param bridgePort - configured fixed port; `0` asks the OS for one.
 * @returns the state the extension status route reports, mutated when the bind settles.
 */
export declare function installExtensionBridge(ctx: Context, backend: BrowserBackend, screenshotDir: string, bridgePort: number): BridgeReport;
//# sourceMappingURL=bridge.d.ts.map