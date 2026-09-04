// Single source of truth for the panel origin, shared by
// background/service-worker.js (via importScripts, since the service
// worker is a classic script - manifest.json declares no "type":
// "module") and content-scripts/keyword-blocker.js (via manifest.json's
// content_scripts array listing this file first - multiple content
// scripts share one execution context per frame, so a plain `const`
// here is visible to a file loaded after it, no export/import needed).
//
// Hardcoded, not configured through an options page - explicit design
// choice, 2026-09-04, replacing what workerUrl/syncToken (chrome.storage.local,
// options/options.html) used to do. This project is single-user/single-
// deployment: there is exactly one real panel this extension will ever
// talk to, the same reasoning that already justifies hardcoding
// EXTENSION_ID server-side (worker/src/extensionUpdate.ts) and
// SyncBaseURL in profiles/santa-config.mobileconfig. Baking it in here
// means the extension needs zero per-machine setup after being
// force-installed - no token to generate, no URL to type in, nothing
// that can be left unconfigured or get wiped by a reinstall (see this
// project's own history of exactly that happening to workerUrl/syncToken
// across the Chrome extension's stuck-update saga).
//
// If this project's panel domain ever changes, this is the one place to
// update it - keep it in sync with profiles/chrome-policy.mobileconfig's
// ExtensionInstallForcelist entry pointing at the same host, and
// profiles/santa-config.mobileconfig's SyncBaseURL.
const CONTENTGUARD_PANEL_URL = "https://panel.lukep009.download";
