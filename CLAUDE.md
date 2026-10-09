# ContentGuard

Self-imposed, hard-to-disable content blocking, on two platforms plus a shared control panel. This is **not** just an Android app.

| Path | What it is |
|---|---|
| `app/` | Android app (Kotlin/Gradle, accessibility-service based). Build notes: `SETUP.md`. |
| `mac/` | macOS side: `ContentGuardAgent` (screen capture + NudeNet via CoreML), `ContentGuardDaemon` (tamper anchor, Santa/app-lock), installer, LaunchAgents/Daemons. Read `mac/README.md` (phased build log) and `mac/docs/`. |
| `chrome-extension/` | MV3 extension force-installed by MDM: keyword blocking + NSFW image classification (ONNX Runtime Web, CPU/WASM). |
| `worker/` | Cloudflare Worker + D1: the control panel (dashboard, Santa sync server, ratchet, extension update server). |
| `web/` | React dashboard ("Central"), served by the Worker at `/central/*`. |
| `profiles/` | MDM `.mobileconfig` files (pushed via SimpleMDM, not deployed by git). |

## Branches

The default branch is `claude/contentguard-macos-phase-0-47king` (long-lived; it carries everything above). `main` is frozen at the old Android-only line. CI triggers are hardcoded to the default branch's name - rename it and you must update `.github/workflows/deploy-worker.yml`.

## Core design rule: the ratchet

Tightening applies immediately. **Every loosening needs the dashboard password plus a 24h delay** (`worker/src/ratchet.ts`; tables `pending_*`). Do not add a loosening path that skips it, and do not hand over a bypass (e.g. direct `wrangler d1 execute` writes) without the user explicitly asking and confirming. Before treating a new rule/endpoint as "a tightening", check it under Santa **LOCKDOWN** (default-deny) as well as MONITOR - an ALLOWLIST rule is a loosening there.

## Deploy mechanics (things that bite)

- **Worker**: pushing `worker/**` triggers `deploy-worker.yml`, but the deploy job waits on a human approval (`release` environment). If a change "isn't live", check Actions for a `waiting` run first.
- **D1 migrations**: push tag `d1-migrate-NNNN` (NNNN = migration number). Also approval-gated. Remote Claude sessions cannot push tags - the user runs it. A Worker deployed before its migration is applied throws 500s on the new tables.
- **wrangler**: `r2 object put` and `d1 execute` silently hit a *local* simulator unless `--remote` is passed.
- **Santa mode** lives in D1 (`devices.client_mode`, set from the dashboard), not only in `santa-config.mobileconfig`; Santa's sync response overrides the profile.
- **MDM profiles**: bump `PayloadVersion` on both levels when editing. Never put `--` inside an XML comment (breaks plist parsing); validate with `python3 -c "import plistlib; plistlib.load(open(f,'rb'))"`.
- **Chrome extension releases**: bump `chrome-extension/manifest.json` version *and* `EXTENSION_VERSION` in `worker/src/extensionUpdate.ts` together; the user runs `chrome-extension/build/package-crx.sh` on their Mac (it holds `key.pem` - never run it remotely, never regenerate the key: that changes the extension ID); upload with `--remote`; approve the Worker deploy so `update.xml` advertises the new version. A stale local checkout once packaged an old `manifest.json` into the `.crx` and Chrome silently rejected it - `git pull` before packaging. If Chrome won't pick up a new version, remove then restore `ExtensionInstallForcelist` in the Chrome policy profile (two profile pushes).
- **Mac installer**: built and signed on GitHub (`.github/workflows/build-mac.yml`), see `mac/` docs for the signing-secret setup.

## Working notes

- The user's Mac checkout is `/Users/lukepowell/guard`; the logged-in GUI user is `lukepowell` (running Chrome/commands via `su lukepowelladmin` targets a different account's processes and profile).
- Large logs (netlogs etc.) must be filtered locally before pasting into chat - pasting tens of MB breaks a session.
