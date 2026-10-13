# @liyuera/dsh-dev-dock

Frontend project engineering management for DeepSeek Harness, v2: projects are dsh workspaces (no separate registry), one-click start-work, and deterministic desktop actions that open projects in an IDE or a system terminal window. No agent in the loop, no approval prompt — the button click is the user's authorization. The only guard is the sandbox mode: `read-only` denies desktop side effects.

## Install

```sh
dsh plugin --profile desktop add @liyuera/dsh-dev-dock        # from npm (GUI: Settings → Plugins → Add plugin)
dsh plugin --profile desktop add link:/path/to/deepseek-harness-plugin/dev-dock   # from a local checkout
```

`desktop` is the profile the desktop app owns; a source run (`pnpm dsh web`) uses `web`. Restart dsh after installing — the host half loads only at startup. The sidebar foot shows **开始上班** (start-work dialog) above a `devDock - N项目` row (N = workspace count); every session header gets **IDE / 终端 / 启动** actions for its workspace; the devDock settings page opens from **设置 → devDock**.

## UI surfaces

| Surface | Slot | Purpose |
|---|---|---|
| 开始上班 button + devDock entry row | `sidebar.footer.action` | start-work dialog (remembered selection) + project count |
| IDE / 终端 / 启动 | `conversation.session.header.actions` | open editor / open system terminal / both, for the current session's workspace |
| start-work dialog | `shell.overlay` | checkbox list of workspaces, prefill from last selection |
| devDock settings page | `settings.section` | per-workspace editor preference, editor manual paths + detection refresh, terminal preference |

## How it works

- **Projects are dsh workspaces** (the workspace registry is the fact source; deleted workspaces simply drop out).
- **Settings namespace `dev-dock`** holds only preferences: `workspacePrefs` (per-workspace IDE), `editors` (detected + manual paths), `terminalApp` (Terminal.app / iTerm), `startWork` (selection memory).
- **Default editor**: per-workspace preference first; otherwise auto-detected — uni-app traits (manifest.json / project.config.json) prefer HBuilderX, other projects prefer WebStorm, then any installed editor.
- **Actions are deterministic**: the browser half POSTs a JSON action to the host route `/dev-dock/action` (registered through `webServer`); the host runs the open directly. Static client bundles have no package-private RPC channel (`host.call` is a dynamic-plugin builtin), so the loopback route is the sanctioned channel. The route is registered only when a web server is present; headless profiles just keep the settings namespace.
- **read-only guard**: `sandboxPolicy.resolve().mode === 'read-only'` rejects every action with an error.

## Build

```sh
tsc -b && tsdown --config-loader tsx   # bins resolve from the harness root node_modules
```

The out-of-tree bundles (host halves plus `lib/client.js`) are built by this repo's shared helper, [`build/client-bundle.ts`](../build/client-bundle.ts). `lib/` artifacts are committed, install-and-go.

## Known limitations (v1)

- The devDock entry row opens the start-work dialog (the settings shell exposes no cross-plugin API to open the panel on a chosen section); the settings page is reached through 设置 → devDock.
- Tests for v1 were removed with the v1 surface; host unit tests (editor merge, action command building) and client component specs are the next iteration item.
- Windows detection and terminal fallback remain untested on real Windows hardware.
- The HTTP action route is loopback-bound like the rest of the web server; the browser page is the only same-origin caller.

## Configuration

No plugin configuration options. Everything user-selectable (per-workspace editor, manual editor paths, terminal app, last start-work selection) lives in the `dev-dock` settings namespace and is edited from **设置 → devDock**. The host half declares `@deepseek-ai/cordis` as a peer dependency; `dsh plugin add` refuses to install this package on a dsh version outside that range.

## Uninstall

```sh
dsh plugin --profile desktop remove @liyuera/dsh-dev-dock
```

The `dev-dock` settings namespace stays in storage; reinstalling restores the previous preferences.

## License

Proprietary, `UNLICENSED`: installing and running this package through npm is permitted (see the bundled `LICENSE` for the full text). Modifying, redistributing, sublicensing or selling it is not.
