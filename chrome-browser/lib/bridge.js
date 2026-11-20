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
import { BridgeServer } from "./local-server.js";
import { registerExtensionRoutes } from "./routes.js";
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
export function installExtensionBridge(ctx, backend, screenshotDir, bridgePort) {
    const report = { port: bridgePort, carrier: 'webServer', listening: false };
    const webServerPort = ctx.get('webServer')?.port;
    if (webServerPort === bridgePort) {
        report.listening = true;
        return report;
    }
    report.carrier = 'plugin';
    const server = new BridgeServer();
    const disposeRoutes = registerExtensionRoutes(server, backend, screenshotDir, report);
    ctx.effect(() => {
        let disposed = false;
        void server.listen(bridgePort).then((port) => {
            if (disposed)
                return;
            report.port = port;
            report.listening = true;
        }, (error) => {
            if (disposed)
                return;
            // A port another process owns is reported, not retried: the user can
            // read the reason in /chrome-browser/ext/status.
            report.error = error instanceof Error ? error.message : String(error);
        });
        return () => {
            disposed = true;
            disposeRoutes();
            void server.close();
        };
    }, 'chrome-browser: extension bridge server');
    return report;
}
//# sourceMappingURL=bridge.js.map