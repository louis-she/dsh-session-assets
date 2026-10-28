# dsh-session-assets

[中文](README.md) · [English](README.en.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web plugin that adds **per-session file assets**: **download buttons on chat cards**, a **「文件」 (Files) view** in the main conversation area, a **session files panel** in the right sidebar, **download actions in the file-preview drawer** — with every produced file archived inside the session's own directory so it **dies with the session**.

> One package ships both halves — host (`lib/index.js`) and browser (`lib/client.js`) — with zero third-party dependencies and no build step. Installable from npm through DSH's plugin manager, or run straight from a local path while developing.

## What you get

| Entry point | Where | Notes |
|---|---|---|
| ⬇ download button | `present` file cards in the chat | No Host desktop required — works over remote access |
| **Files view** | Main conversation tab (beside 对话) | Every file this session produced, each row downloadable |
| **Session files panel** | Right sidebar tab (guide entry) | Same data source as the Files view |
| Preview drawer download | Previewable header actions + the "该格式文件暂时无法预览" empty state | Both previewable (csv/text/images) and unpreviewable (zip, …) files |

Row badges distinguish provenance: **archived** (a copy in `assets/`), **not archived** (`present`-ed but no surviving copy), **written** (durable `write`/`edit` tool output), **gone** (source deleted).

## Install

### Option 1 — plugin manager (recommended; the way to hand it to others)

Published on npm as **`dsh-session-assets`**. Either route:

- **UI**: Settings → Plugins → “Add plugin” → type `dsh-session-assets` → install
- **CLI**: `dsh plugin --profile web add dsh-session-assets`

The installer (a `pnpm add` underneath) places the package in the profile's `node_modules/` and applies the bundled `cordis.patch.yml` (the insert entry below) — active immediately. Upgrading = uninstall then install the new version; uninstalling is one click in the plugins page.

> The package is a **bundle**: package.json declares `dsh.bundle.patch`, which is exactly what the “Add plugin” UI requires, while keeping the `dsh.client` dual-face declaration so the browser half ships through DSH's module system at runtime — still no build step.

### Option 2 — local path (development; edits hot-reload instantly)

```bash
git clone https://github.com/louis-she/dsh-session-assets ~/.dsh/profiles/web/plugins/session-assets
```

Then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: session-assets
      # Must be a file: URL pointing at lib/index.js — both pitfalls are real:
      #  - a directory path is rejected by Node ESM (ERR_UNSUPPORTED_DIR_IMPORT)
      #  - a bare absolute path leaves the client bundle undiscovered
      #    (host loads, browser never receives the module)
      name: "file:///Users/<you>/.dsh/profiles/web/plugins/session-assets/lib/index.js"
      config: {}
```

Saving is enough: `dsh-hmr` watches the patch file, rebuilds the host fiber within seconds, and the browser receives the new client bundle over the `/plugins/events` SSE channel **without a refresh**.

### Configuration

```yaml
      config:
        sessionsRoot: ~/dsh-sessions   # asset root; defaults to the persistence root (~/.dsh/sessions)
```

### Uninstall

- Installed via the plugin manager: one click in the plugins page, or `dsh plugin --profile web remove dsh-session-assets`
- Registered by local path: remove the `insert` entry (then refresh the browser once) and delete the package directory if you like

Archived assets stay in each session directory — they belong to the sessions, not the plugin.

## Architecture

```
Browser (lib/client.js)                       Host (lib/index.js, cordis plugin)
├─ card button   ──HEAD+GET──▶ /api/session.assets.present?sessionId&seq&index
├─ preview drawer ─HEAD+GET──▶ /api/session.assets.file?sessionId&path
├─ file lists    ─────GET────▶ /api/session.assets.list?sessionId
│    ├─ archived assets ◀────  <sessionDir>/assets/  (manifest.json)
│    ├─ presented files ◀────  deliverables/presented events
│    └─ written output  ◀────  tool/call + tool/result events (durable log derivation)
└─ row download  ──HEAD+GET──▶ /api/session.assets.download?sessionId&name

session/event(deliverables/presented) ──▶ copy source file into <sessionDir>/assets/
```

**Storage layout** (mirrors session persistence, so deleting the session directory deletes its assets):

```
~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/
├── session.v4.jsonl.zstd      # DSH's own
├── session.lock
└── assets/                    # this plugin
    ├── manifest.json          # {seq, index, source, name, bytes, mtimeMs, description}
    └── <archived copies…>
```

`encodeSegment` / `projectKey` mirror `dsh-session-persistence-jsonl` (verified byte-for-byte against real session directories), with a directory-scan fallback when the header's `cwd` is unavailable.

## Security model

- **Every route sits inside Connection's authenticated fence**: a plain browser GET carries the signed cookie automatically (same mechanism as the official `/api/session.export`), no token plumbing.
- **Read authority matches the preview itself** ("readable ⇒ downloadable"), identical to DSH's own `workspaceFiles` read semantics; the cookie is the exposure boundary.
- The `download` route's `name` parameter refuses path traversal (single path segment only); the `file` route refuses NUL.
- Responses stream (`Readable.toWeb(createReadStream(...))`) — **no size cap**, nothing buffered whole in memory.

## Development

```bash
node test/smoke.mjs         # host: mock context covering every route, archive copy, idempotency, traversal
node test/client-smoke.mjs  # browser: stubbed react/DOM running apply, registrations, and click paths
```

Hot-reload rules you will lean on constantly:

- Edit `lib/client.js` → `dsh-client-hmr` polls bundle metadata every 500 ms and pushes over SSE; the **browser updates without a refresh**.
- Edit `lib/index.js` → the file change alone does **not** reload the host; touch `cordis.patch.yml` again (a comment edit is enough) to trigger a reconcile.

Self-instrumentation (this deployment discards stdout/stderr):

- `.state.json` — load time, effective config, registered routes
- `.log` — diagnostics (route failures, archive errors)

Browser-side verification:

```bash
curl -N http://127.0.0.1:3080/plugins/events          # SSE graph should contain {"id":"dsh-session-assets",...}
curl "http://127.0.0.1:3080/plugins/??dsh-session-assets/client.js&rev=<rev>"
```

## Design decisions

- **Assets live inside the session directory**, not a separate asset root: the persistence source explicitly reserves the session directory "for future session-local artifacts", DSH exposes no public session-deletion API (`session/disposed` also fires on process shutdown, so it cannot gate deletions), and file-system semantics then guarantee "delete the session ⇒ delete its assets".
- **Downloads stream over HTTP routes + an anchor**, not `workspaceFiles.readBytes`: the latter caps files at 32 MB and buffers them in the browser.
- **"Written" files derive from the session log**, not the in-memory `workspace/changes` summary (lost on restart): the plugin mirrors deliverables' success criteria for `write`/`edit`/`str_replace_editor`, keeping the list durable and consistent with the official derivation.
- **The Files view uses the fresh id `session-files`** (`chat`=0, `trajectory`=10, this plugin=20); reusing a native id would evict that native tab.

## License

[MIT](LICENSE)
