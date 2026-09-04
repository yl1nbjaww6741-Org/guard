// The dashboard frontend - the last piece of Phase 4's "single control
// panel" scope decision (mac/README.md's Phase 4 row). A single static
// HTML page with inline vanilla JS, served directly by this Worker (no
// separate build step, no external CDN dependency - Workers can't
// reliably reach arbitrary external hosts from every request path
// anyway, and this project's whole ethos is minimal moving parts). Calls
// the same-origin /api/... endpoints already built and verified in
// earlier commits - this file adds no new backend logic of its own.
//
// Auth: a password gate built into this Worker (session.ts issues a
// signed cookie after login), not Cloudflare Access - see this project's
// git history and schema.sql's dashboard_auth comment for why that
// changed. index.ts decides which of the two functions below to render
// based on whether the request already carries a valid session.

const SHARED_STYLES = `
  :root { color-scheme: dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #14161a; color: #e8e8ea; margin: 0; padding: 2rem;
    max-width: 900px; margin-inline: auto;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .subtitle { color: #8b8f98; font-size: 0.85rem; margin-bottom: 2rem; }
  section { margin-bottom: 2.5rem; }
  h2 { font-size: 1.05rem; border-bottom: 1px solid #2a2d33; padding-bottom: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.75rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #22252b; }
  th { color: #8b8f98; font-weight: 500; }
  .policy-BLOCKLIST, .policy-SILENT_BLOCKLIST { color: #ff6b6b; }
  .policy-ALLOWLIST, .policy-ALLOWLIST_COMPILER { color: #51cf66; }
  .policy-REMOVE { color: #8b8f98; }
  button {
    background: #2a2d33; color: #e8e8ea; border: 1px solid #3a3e46;
    border-radius: 6px; padding: 0.35rem 0.75rem; font-size: 0.8rem; cursor: pointer;
  }
  button:hover { background: #34383f; }
  button.danger { border-color: #6b2c2c; color: #ff8787; }
  button.danger:hover { background: #3a2222; }
  form.inline { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; align-items: center; }
  input, select { background: #1c1e23; color: #e8e8ea; border: 1px solid #3a3e46; border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.85rem; }
  .pending-note { color: #ffd43b; font-size: 0.78rem; }
  .static-rule { opacity: 0.7; }
  .static-rule td { font-style: italic; }
  .empty { color: #6b6f78; font-size: 0.85rem; font-style: italic; padding: 0.75rem 0; }
  .error { color: #ff6b6b; font-size: 0.85rem; margin-top: 0.5rem; }
  .status-msg { font-size: 0.8rem; margin-top: 0.5rem; min-height: 1.2em; }
`;

// PWA install support, added 2026-08-25 (explicit user request: "I want
// panel on my phone... make it a PWA app for android") - manifest +
// icons served as plain static files via wrangler.toml's [assets]
// binding (web/dist/manifest.webmanifest, web/dist/icons/*, generated
// by web/reference/gen_icons.py - a simple shield mark matching
// ContentGuard Central's own Wise-light tokens), not new backend logic.
// Registers web/dist/sw.js, which is deliberately a no-op (no caching -
// see that file's own comment: this is a live security dashboard, a
// stale cached response would be actively wrong). On both pages, not
// just the dashboard - Chrome's install prompt considers whichever page
// is open when triggered, and this Worker can render either one first
// depending on session state.
const PWA_HEAD_TAGS = `
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#14161a">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" href="/icons/icon-192.png">`;

const PWA_SW_REGISTER_SCRIPT = `
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}`;

export function renderLoginPage(errorMessage?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContentGuard Control Panel</title>${PWA_HEAD_TAGS}
<style>
  ${SHARED_STYLES}
  body { max-width: 360px; padding-top: 20vh; }
  form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1.5rem; }
  input { padding: 0.6rem 0.7rem; }
  button[type="submit"] { padding: 0.6rem; }
</style>
</head>
<body>
  <h1>ContentGuard Control Panel</h1>
  <div class="subtitle">Sign in to continue.</div>
  <form id="login-form">
    <input type="password" name="password" placeholder="Password" required autofocus>
    <button type="submit">Log in</button>
  </form>
  <div class="error" id="login-error">${errorMessage ? escapeHtmlServer(errorMessage) : ""}</div>
<script>${PWA_SW_REGISTER_SCRIPT}
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = new FormData(e.target).get("password");
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    location.reload();
  } else {
    const text = await res.text().catch(() => res.statusText);
    document.getElementById("login-error").textContent = res.status === 429 ? "Too many failed attempts - try again later." : "Incorrect password.";
  }
});
</script>
</body>
</html>`;
}

function escapeHtmlServer(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContentGuard Control Panel</title>${PWA_HEAD_TAGS}
<style>
  ${SHARED_STYLES}
  .top-bar { display: flex; justify-content: space-between; align-items: baseline; }
  .tab-nav { display: flex; gap: 0.25rem; border-bottom: 1px solid #2a2d33; margin: 1.5rem 0 2rem; }
  .tab-btn {
    background: transparent; border: none; border-bottom: 2px solid transparent;
    border-radius: 0; color: #8b8f98; padding: 0.6rem 0.9rem; font-size: 0.9rem; cursor: pointer;
  }
  .tab-btn:hover { color: #e8e8ea; background: transparent; }
  .tab-btn.active { color: #e8e8ea; border-bottom-color: #51cf66; }
  .status-row { padding: 0.4rem 0; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem; }
  .status-row.error { color: #ff6b6b; }
  .status-dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; flex-shrink: 0; }
  .mdm-status-verified { color: #51cf66; }
  .mdm-status-pending, .mdm-status-verifying { color: #ffd43b; }
  .mdm-status-failed { color: #ff6b6b; }
  /* SimpleMDM's profiles endpoint has no verified/pending/failed concept
     at all (confirmed against a real device, 2026-08-26) - "assigned"
     is the honest ceiling of what that data can say, styled distinctly
     from "unknown" (a real absence of data) rather than colored like a
     problem. */
  .mdm-status-assigned { color: #74c0fc; }
  details.profile-details { border-bottom: 1px solid #22252b; padding: 0.5rem 0; }
  details.profile-details summary { cursor: pointer; font-size: 0.85rem; }
  details.profile-details summary span { font-weight: 600; margin-right: 0.5rem; }
  details.profile-details ul { margin: 0.5rem 0 0.6rem 1.2rem; font-size: 0.8rem; color: #c3c6cc; }
  details.profile-details li { margin-bottom: 0.2rem; }
  details.profile-details form.inline { margin-top: 0.4rem; }
</style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>ContentGuard Control Panel</h1>
      <div class="subtitle">Phase 4 - Santa rules and Fleet software, one place instead of jumping between apps.</div>
    </div>
    <button id="logout-btn">Log out</button>
  </div>

  <nav class="tab-nav">
    <button class="tab-btn" data-tab="mac">Mac</button>
    <button class="tab-btn" data-tab="android">Android</button>
    <button class="tab-btn" data-tab="networking">Networking</button>
    <button class="tab-btn" data-tab="access-map">Access map</button>
    <button class="tab-btn" data-tab="architecture">Architecture</button>
  </nav>

  <div id="tab-mac" class="tab-panel">

  <section>
    <h2>Sync health</h2>
    <div class="subtitle" style="margin-bottom: 0;">Two separate signals, on purpose - a Mac can be Fleet-online while Santa's sync is stalled, or vice versa.</div>
    <div id="sync-health-body">Loading...</div>
  </section>

  <section>
    <h2>MDM lockdown</h2>
    <div class="subtitle" style="margin-bottom: 0;">What the MDM (SimpleMDM) has actually confirmed applied, not just what profiles/ intends.</div>
    <div id="mdm-lockdown-body">Loading...</div>
    <div class="subtitle" style="margin-top: 1rem; margin-bottom: 0;">Uploads and updates take effect after a 24h delay, same as loosening a Santa rule - see mac/docs/PHASE_4_DASHBOARD_SETUP.md's "Loosening MDM profile restrictions" section.</div>
    <form class="inline" id="upload-profile-form" style="margin-top: 0.5rem;">
      <input type="file" name="profile" accept=".mobileconfig" required>
      <input type="password" name="password" placeholder="Password to confirm" required style="min-width: 160px;">
      <button type="submit">Queue upload (24h delay)</button>
    </form>
    <div class="status-msg" id="upload-profile-status"></div>
    <div id="profile-changes-pending"></div>
  </section>

  <section>
    <h2>Santa (app execution control)</h2>
    <div class="subtitle" style="margin-bottom: 0;">One list: Santa's actual enforced block/allow rules (static profile entries plus everything added dynamically) - the source of truth for what runs on this Mac - plus every app found on this Mac with a real Team ID (AppInventoryScanner.swift, daemon-side, synced every 15 minutes) that doesn't have a rule yet, with Allow/Block right there instead of typing an identifier by hand. LOCKDOWN mode is default-deny, so every app someone actually uses needs a real ALLOWLIST Team ID rule - that's what those un-ruled rows, and the Allow all button below, are for. An app with no Team ID (unsigned, ad-hoc signed, or one of Apple's own platform binaries) never shows up needing one - see the Architecture tab's Santa row for why that's fine for Apple's own binaries specifically.</div>
    <table id="rules-table">
      <thead><tr><th>Name</th><th>Identifier</th><th>Type</th><th>Policy</th><th>Scope</th><th></th></tr></thead>
      <tbody id="rules-body"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
    </table>
    <div class="inline">
      <button id="allow-all-app-inventory">Allow all (queue ALLOWLIST for every un-ruled app above)</button>
    </div>
    <form class="inline" id="add-rule-form">
      <input name="app_name" placeholder="App name (e.g. Tor Browser)" style="min-width: 160px;">
      <input name="identifier" placeholder="Identifier (SHA-256 / Team ID / etc)" required style="flex: 1; min-width: 220px;">
      <select name="rule_type">
        <option value="TEAMID">Team ID</option>
        <option value="CERTIFICATE">Certificate</option>
        <option value="BINARY">Binary</option>
        <option value="SIGNINGID">Signing ID</option>
        <option value="CDHASH">CDHash</option>
      </select>
      <select name="policy">
        <option value="BLOCKLIST">Block</option>
        <option value="ALLOWLIST">Allow</option>
        <option value="SILENT_BLOCKLIST">Block (silent)</option>
      </select>
      <button type="submit">Add rule</button>
    </form>
    <div class="status-msg" id="rules-status"></div>
  </section>

  <section>
    <h2>ContentGuard (screen-capture scanning)</h2>
    <div class="subtitle" style="margin-bottom: 0;">One list: every bundle ID ContentGuardDaemon already excludes from screen-capture monitoring (a blind spot, kept short and deliberate - static compiled baseline plus everything added dynamically), plus every other app SimpleMDM's inventory (or the hand-kept list of built-in Apple apps, see knownApps.ts) knows about, with a Whitelist button right there instead of typing a bundle ID by hand. Adding one takes effect after a 24h delay and a re-entered password, same ratchet as loosening a Santa rule; removing or cancelling one is immediate. Anything still carrying an unrecognized com.apple.* bundle ID (background helpers, framework-hosted components) is filtered out entirely, not shown - nobody's realistically whitelisting those, and SimpleMDM's inventory reports far more of them than Fleet's own scoped query ever surfaced.</div>
    <table id="safe-apps-table">
      <thead><tr><th>App</th><th>Bundle ID</th><th>Status</th><th></th></tr></thead>
      <tbody id="safe-apps-body"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="load-apps-form">
      <input name="host" placeholder="Different host? (hostname, serial, or UUID)" style="flex: 1; min-width: 220px;">
      <button type="submit">Load</button>
    </form>
    <div class="status-msg" id="safe-apps-status"></div>
  </section>

  <section>
    <h2>Keyword blocker (Chrome extension)</h2>
    <div class="subtitle" style="margin-bottom: 0;">Every keyword the Chrome extension blocks on top of its NSFW image classifier - a page whose URL or rendered text/title contains the FULL phrase below gets closed automatically (background/service-worker.js's declarativeNetRequest rule for the URL, content-scripts/keyword-blocker.js's page-text scan for everything else). Matching is always the whole phrase, never a partial word or prefix of it - "reddit media downloader" only matches that exact phrase, never "reddit" or "reddit media" appearing alone on some unrelated page. This panel's own origin is always exempt from every keyword below (both enforcement paths check for it explicitly) - otherwise the extension would block the very page used to manage this list the moment a real keyword goes on it, a real bug this project hit once already. Adding a keyword blocks more, so it applies immediately; removing one blocks less, so it takes the same 24h-delay-plus-re-entered-password ratchet as loosening a Santa rule.</div>
    <table id="keywords-table">
      <thead><tr><th>Keyword</th><th>Added</th><th></th></tr></thead>
      <tbody id="keywords-body"><tr><td colspan="3" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="add-keyword-form">
      <input name="keyword" placeholder="Full phrase to block (e.g. reddit media downloader)" required style="flex: 1; min-width: 260px;">
      <button type="submit">Add keyword</button>
    </form>
    <div class="status-msg" id="keywords-status"></div>
  </section>

  <section>
    <h2>Software</h2>
    <table id="software-table">
      <thead><tr><th>Name</th><th>Version</th><th>Platform</th><th></th></tr></thead>
      <tbody id="software-body"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="upload-form">
      <input type="file" name="software" accept=".pkg,.msi,.exe,.deb,.rpm,.tar.gz,.ipa" required>
      <button type="submit">Upload package</button>
    </form>
    <div class="status-msg" id="software-status"></div>
  </section>

  <section>
    <h2>Change login password</h2>
    <div class="subtitle" style="margin-bottom: 0;">The everyday credential that gets you into this dashboard at all, and lets you view/tighten once you're in. Separate from the office password below - changing this one takes effect immediately, no delay, since it doesn't loosen or tighten anything on its own.</div>
    <form class="inline" id="change-login-password-form">
      <input type="password" name="current_password" placeholder="Current login password" required>
      <input type="password" name="new_password" placeholder="New login password" required>
      <button type="submit">Change now</button>
    </form>
    <div class="status-msg" id="login-password-status"></div>
  </section>

  <section>
    <h2>Change office password</h2>
    <div class="subtitle" style="margin-bottom: 0;">The one that unlocks loosening - required to un-block a Santa rule, add a safe app, or edit an MDM profile. Deliberately kept somewhere you can't casually reach day-to-day; this dashboard no longer needs it just to log in. See the Access map tab for the full list of what this password gates.</div>
    <div id="password-pending-note"></div>
    <form class="inline" id="change-password-form">
      <input type="password" name="current_password" placeholder="Current office password" required>
      <input type="password" name="new_password" placeholder="New office password" required>
      <button type="submit">Request change</button>
    </form>
    <div class="status-msg" id="password-status">Takes effect 24 hours after requesting, same as loosening a rule.</div>
  </section>

  </div>

  <div id="tab-android" class="tab-panel" hidden>
    <div class="empty">Coming soon.</div>
  </div>

  <div id="tab-networking" class="tab-panel" hidden>
    <div class="empty">Coming soon.</div>
  </div>

  <div id="tab-access-map" class="tab-panel" hidden>

  <section>
    <h2>Two passwords, not one</h2>
    <div class="subtitle" style="margin-bottom: 0;">Hand-kept, not computed live - same reasoning as the MDM profile detail mirror above: this Worker only ever stores SHA-256 hashes (schema.sql's login_auth and dashboard_auth tables), never a plaintext password, so nothing on this page can reveal what either one actually is. What follows is a real, code-verified map of what each unlocks, not a guess.</div>
    <p style="font-size: 0.85rem; color: #c3c6cc; margin: 0.6rem 0;">Changed 2026-08-25 from a single unified password to two separate ones: the <strong>login password</strong> (<code>login_auth</code>) gets you into this dashboard and lets you view/tighten once you're in - an everyday credential, not kept out of reach. The <strong>office password</strong> (<code>dashboard_auth</code>) is the one deliberately kept somewhere you can't casually reach, and it's <em>only</em> re-checked at the moment of an actual loosening action below - being logged in is no longer enough on its own, but it's also no longer required just to look at this dashboard.</p>
  </section>

  <section>
    <h2>What the office password unlocks</h2>
    <table>
      <thead><tr><th>Action</th><th>Where in this system</th><th>What it actually does</th></tr></thead>
      <tbody>
        <tr><td>Un-blocking a Santa rule</td><td>Santa section, Rules table, "loosen request"</td><td>Queues a rule for REMOVE - e.g. this is what unblocked Codex/ChatGPT's TEAMID</td></tr>
        <tr><td>Adding a safe app (screen-capture exemption)</td><td>ContentGuard section, Safe apps table</td><td>Queues a bundle ID to stop being scanned by ContentGuardDaemon - e.g. the com.google.Chrome addition</td></tr>
        <tr><td>Uploading or updating an MDM profile</td><td>MDM lockdown section</td><td>Queues new .mobileconfig content to push to Fleet - this is how restrictions.mobileconfig/chrome-policy.mobileconfig themselves get changed</td></tr>
        <tr><td>Removing a blocked keyword</td><td>Keyword blocker section</td><td>Queues a keyword for deletion from blocked_keywords - the Chrome extension stops blocking it once applied</td></tr>
        <tr><td>Changing the office password itself</td><td>Change office password section</td><td>Requires the current one to set a new one - can't be reset without already having it, and the change itself still waits the same 24h delay</td></tr>
      </tbody>
    </table>
    <div class="subtitle" style="margin-top: 0.6rem; margin-bottom: 0;">All five are loosening actions - none apply instantly even with the password: every one still waits the 24h ratchet delay before taking effect, same asymmetry as everywhere else in this project.</div>
  </section>

  <section>
    <h2>What the login password unlocks</h2>
    <div class="subtitle" style="margin-bottom: 0;">Just one thing: <code>handleLogin</code>, index.ts - reaching this dashboard at all. From there, every tightening action (blocking a Santa rule, adding a blocked keyword, removing a safe-app exemption) is available immediately, no further password - only loosening actions re-check the office password above. Changing the login password itself (Change login password section) is immediate too, no 24h delay, since it doesn't loosen or tighten anything on its own.</div>
  </section>

  <section>
    <h2>What needs no password at all</h2>
    <div class="subtitle" style="margin-bottom: 0;">Tightening actions, from an ordinary logged-in session - blocking a Santa rule, adding a blocked keyword, removing a safe app (revoking a scan exemption). Only the direction that makes this Mac less restricted is gated behind the office password; making it more restricted never is.</div>
  </section>

  <section>
    <h2>Outside this system</h2>
    <div class="subtitle" style="margin-bottom: 0;">
      As told to this dashboard by the user, not something this Worker can verify on its own - these live in a password manager, not this codebase, so treat this list as a reference maintained by hand, same as everything else on this tab. The office password above is the shared password protecting all of these too:
    </div>
    <ul style="margin: 0.6rem 0 0 1.2rem; font-size: 0.85rem; color: #c3c6cc;">
      <li>Recovery lock (rotates on Fleet)</li>
      <li>Mac OS admin account</li>
      <li>Control Panel (this dashboard's own office password entry)</li>
      <li>Fleet</li>
      <li>Hide apps Oppo</li>
      <li>Unifi</li>
      <li>Content Guard Android</li>
      <li>Github</li>
      <li>Andoff</li>
      <li>Cloudflare</li>
      <li>Tesla</li>
      <li>Gmail</li>
    </ul>
    <div class="subtitle" style="margin-top: 0.6rem; margin-bottom: 0;">
      Worth noting plainly, not just implied: this means the blast radius of the office password is real infrastructure and personal accounts (Cloudflare - the account this whole Worker/Fleet setup runs on, GitHub - this repo, Gmail, Tesla), not just this dashboard's own loosening actions. Reusing one password across that many places is a real, separate tradeoff from anything the ratchet mechanism itself is designed to address - worth keeping in mind independent of this project.
    </div>
  </section>

  </div>

  <div id="tab-architecture" class="tab-panel" hidden>

  <section>
    <h2>What this is</h2>
    <div class="subtitle" style="margin-bottom: 0;">ContentGuard for macOS: self-imposed, hard-to-disable content blocking on this specific Mac, extended from the same model the sibling Android app already uses. Hand-kept summary, not generated - see mac/README.md's own phase-by-phase build order for the full detail behind every line here.</div>
  </section>

  <section>
    <h2>The pieces, and how they connect</h2>
    <table>
      <thead><tr><th>Layer</th><th>What it is</th><th>What it actually does</th></tr></thead>
      <tbody>
        <tr><td>Fleet (MDM)</td><td>Self-hosted on Fly.io, reached via a Cloudflare Tunnel (cloudflared)</td><td>Enrolls and supervises this Mac, pushes every .mobileconfig profile, holds Recovery Lock</td></tr>
        <tr><td>Cloudflare Gateway / WARP</td><td>Zero Trust DNS + network layer, DNS forced through this org's own Gateway DoH resolver</td><td>NSFW category block, DoH-provider blocklist (blocks bypass via other resolvers), the AI-tool allow/block policy</td></tr>
        <tr><td>.mobileconfig profiles (profiles/)</td><td>7 files, pushed through Fleet</td><td>Restrictions (browser/torrent blocklist, AirDrop, screenshots), Chrome policy (extension force-install), DNS, PPPC (permissions), Santa config + Full Disk Access, System Extensions</td></tr>
        <tr><td>Santa</td><td>App execution control, EndpointSecurity-based, MONITOR mode (not LOCKDOWN)</td><td>Denylists specific known-bad tools by TeamID/certificate (Tor Browser, etc.) - deliberately not a full allowlist gate</td></tr>
        <tr><td>ContentGuardAgent + ContentGuardDaemon</td><td>Native Swift, launchd-managed</td><td>Agent: ScreenCaptureKit capture -> ONNX Runtime/CoreML NudeNet inference -> force-quits the frontmost app on detection. Daemon: tamper-resistant anchor - heartbeat monitoring, fails closed (locks the screen) if the agent goes quiet or gets killed repeatedly</td></tr>
        <tr><td>Chrome extension</td><td>Force-installed via ExtensionInstallForcelist, self-hosted .crx (this Worker + R2)</td><td>The same NudeNet-style NSFW detection ported to the browser, with the same battery-optimization techniques (perceptual hash, skin-tone prefilter) as the native agent, plus a dashboard-managed keyword blocklist (full-phrase matching only, this panel's own origin always exempt - see Keyword blocker section)</td></tr>
        <tr><td>This Worker + dashboard</td><td>Cloudflare Worker, D1 database, Cron Trigger every 15 min</td><td>Santa's sync server (preflight/ruledownload/etc.), the ratchet mechanism (tighten-instantly / loosen-after-24h-and-password), Fleet API proxy, and this control panel</td></tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>The ratchet, in one line</h2>
    <div class="subtitle" style="margin-bottom: 0;">Anything that makes this Mac MORE restricted applies immediately, no password. Anything that makes it LESS restricted needs the office password re-entered and still waits 24 hours - see the Access map tab for exactly which actions that covers.</div>
  </section>

  <section>
    <h2>Status</h2>
    <div class="subtitle" style="margin-bottom: 0;">
      Phases 0-4 of the original six-phase build are done and confirmed working on the real Mac (see mac/README.md for the full verification history of each). This session added a layer on top of that closed scope: the Chrome extension build, its MDM force-install lock-down, and the browser/torrent-client blocklist. <strong>Phase 5 - demoting the daily account to standard and sealing admin credentials in a vault - is the one remaining unstarted step</strong>, runbook at mac/docs/PHASE_5_LOCKDOWN.md.
    </div>
  </section>

  </div>

<script>${PWA_SW_REGISTER_SCRIPT}
async function api(path, opts) {
  const res = await fetch(path, { ...opts, credentials: "include" });
  if (res.status === 401) {
    location.reload(); // session expired - reload will show the login page
    throw new Error("session expired");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(\`\${res.status}: \${text}\`);
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : null;
}

function timeUntil(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return "any moment now";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return \`~\${hours}h \${mins}m\`;
}

// Accepts either an epoch-ms number (Santa's own devices table, from D1)
// or an ISO 8601 string (Fleet's seen_time) - the two data sources
// behind "Sync health" use different timestamp formats natively, and
// converting both to the same relative-time display here is simpler
// than normalizing at the API layer for a value only ever displayed.
function timeAgo(input) {
  const ts = typeof input === "number" ? input : new Date(input).getTime();
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return \`\${mins}m ago\`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return \`\${hours}h ago\`;
  const days = Math.floor(hours / 24);
  return \`\${days}d ago\`;
}

let configProfileDetailsCache = null;
async function loadConfigProfileDetails() {
  if (!configProfileDetailsCache) {
    configProfileDetailsCache = await api("/api/config-profile-details");
  }
  return configProfileDetailsCache;
}

async function loadHostStatus() {
  const [data, profileDetails, pendingProfileChanges] = await Promise.all([
    api("/api/host-status"),
    loadConfigProfileDetails().catch(() => []),
    api("/api/pending-profile-changes").catch(() => []),
  ]);
  renderSyncHealth(data);
  renderMdmLockdown(data, profileDetails, pendingProfileChanges);
  renderPendingProfileChanges(pendingProfileChanges);
}

// Every queued profile create/update, in one place - covers both
// pending updates (which also get an inline note on their own profile
// row, see renderMdmLockdown) and pending creates (which have no row of
// their own to show up in at all, since Fleet hasn't assigned a
// profile_uuid yet). Cancelling from here works for both kinds - see the
// #profile-changes-pending click listener below.
function renderPendingProfileChanges(pending) {
  const el = document.getElementById("profile-changes-pending");
  if (!pending || pending.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = pending.map((p) => {
    const label = p.action === "create"
      ? \`Upload "\${escapeHtml(p.filename || "new profile")}"\`
      : \`Update \${escapeHtml(p.filename || p.profile_uuid)}\`;
    const errNote = p.apply_error
      ? \` <span class="pending-note" style="color:#ff6b6b;">(last attempt failed: \${escapeHtml(p.apply_error)} - will retry)</span>\`
      : "";
    return \`<div class="status-row">\${label}: <span class="pending-note">queued, applies in \${timeUntil(p.applies_at)}</span>\${errNote} <button data-cancel-profile-change="\${p.id}">Cancel</button></div>\`;
  }).join("");
}

// Santa's sync freshness (devices.last_preflight_at) and the MDM's own
// last-seen recency are genuinely different signals - see
// hostStatus.ts's doc comment. Both shown here, neither substituting
// for the other. 30 minutes is 3x Santa's own FullSyncInterval (10
// minutes, confirmed via santactl status on the real Mac) - comfortably
// past due before flagging it stale, not a hair-trigger on normal sync
// jitter.
const SANTA_STALE_MS = 30 * 60 * 1000;

// MDM check-in cadence is inherently much coarser than Santa's active
// sync protocol - a real device response (2026-08-26) showed a genuine
// enrollment-state word ("enrolled") in the field Fleet used for
// "online"/"offline"/"missing", with no separate live-connectivity
// signal at all beyond last_seen_at. Reusing SANTA_STALE_MS's 30-minute
// window here would show red constantly on a perfectly healthy Mac -
// 6 hours is a much more realistic "hasn't checked in in a concerning
// while" threshold for MDM check-ins specifically.
const MDM_STALE_MS = 6 * 60 * 60 * 1000;

function renderSyncHealth(data) {
  const el = document.getElementById("sync-health-body");
  const rows = [];

  if (data.fleet) {
    const seenAt = data.fleet.seen_time ? new Date(data.fleet.seen_time).getTime() : NaN;
    const recent = !Number.isNaN(seenAt) && Date.now() - seenAt <= MDM_STALE_MS;
    rows.push(\`<div class="status-row\${recent ? "" : " error"}"><span class="status-dot" style="background:\${recent ? "#51cf66" : "#ff6b6b"}"></span><strong>MDM</strong>&nbsp;- \${escapeHtml(data.fleet.status)}, last seen \${timeAgo(data.fleet.seen_time)}</div>\`);
  } else {
    rows.push(\`<div class="status-row error"><span class="status-dot" style="background:#ff6b6b"></span><strong>MDM</strong>&nbsp;- \${escapeHtml(data.fleetError ?? "not available")}</div>\`);
  }

  if (data.devices.length === 0) {
    rows.push('<div class="empty">No device has ever synced with Santa yet.</div>');
  } else {
    data.devices.forEach((d) => {
      const stale = !d.last_preflight_at || (Date.now() - d.last_preflight_at) > SANTA_STALE_MS;
      const lastSync = d.last_preflight_at ? timeAgo(d.last_preflight_at) : "never";
      rows.push(\`<div class="status-row\${stale ? " error" : ""}"><span class="status-dot" style="background:\${stale ? "#ff6b6b" : "#51cf66"}"></span><strong>Santa</strong>&nbsp;(\${escapeHtml(d.hostname ?? d.machine_id)}) - \${d.client_mode}, last synced \${lastSync}</div>\`);
    });
  }

  el.innerHTML = rows.join("");
}

function renderMdmLockdown(data, profileDetails, pendingProfileChanges) {
  const el = document.getElementById("mdm-lockdown-body");
  if (!data.fleet) {
    el.innerHTML = \`<div class="empty">\${escapeHtml(data.fleetError ?? "Fleet not available")}</div>\`;
    return;
  }
  const f = data.fleet;
  const detailsByName = Object.fromEntries((profileDetails || []).map((d) => [d.name, d]));
  // Only 'update' changes key by profile_uuid - a pending 'create' has
  // none yet (Fleet hasn't assigned one), so it can't be tied to any
  // existing row here; it only shows up in the general
  // #profile-changes-pending list below.
  const pendingByProfileUuid = Object.fromEntries(
    (pendingProfileChanges || []).filter((p) => p.profile_uuid).map((p) => [p.profile_uuid, p])
  );
  const parts = [];

  const deOn = f.disk_encryption_enabled;
  const deLabel = deOn === null ? "unknown" : deOn ? "On" : "Off";
  parts.push(\`<div class="status-row\${deOn === false ? " error" : ""}">Disk encryption: <strong>\${deLabel}</strong></div>\`);

  if (f.mdm) {
    parts.push(\`<div class="status-row\${f.mdm.connected_to_fleet ? "" : " error"}">MDM enrollment: \${escapeHtml(f.mdm.enrollment_status)}\${f.mdm.connected_to_fleet ? "" : " (NOT connected)"}</div>\`);
    if (f.mdm.profiles.length === 0) {
      parts.push('<div class="empty">No configuration profiles reported by Fleet.</div>');
    } else {
      // Each profile is a <details> - click to see what it actually
      // restricts (from configProfiles.ts's hand-kept summary, merged by
      // name) and to queue a replacement via updateConfigurationProfile
      // (through the ratchet - ratchet.ts's requestProfileChange),
      // without leaving this page.
      parts.push(f.mdm.profiles.map((p) => {
        const detail = detailsByName[p.name];
        const restrictionsHtml = detail
          ? \`<ul>\${detail.restrictions.map((r) => \`<li>\${escapeHtml(r)}</li>\`).join("")}</ul>\`
          : '<div class="empty" style="padding:0.25rem 0;">No local detail available for this profile.</div>';
        const pendingChange = pendingByProfileUuid[p.profile_uuid];
        // A pending update already queued for this profile - show its
        // state instead of a second update form (same "don't let two
        // competing changes queue at once" reasoning as the Santa rules
        // table's own loosen-request row). Cancelling happens from the
        // general pending list below, not duplicated here.
        const updateSection = pendingChange
          ? \`<div class="status-row"><span class="pending-note">Update queued, applies in \${timeUntil(pendingChange.applies_at)}</span>\${pendingChange.apply_error ? ' <span class="pending-note" style="color:#ff6b6b;">(last attempt failed, will retry)</span>' : ""}</div>\`
          : \`<form class="inline update-profile-form" data-profile-uuid="\${escapeHtml(p.profile_uuid)}">
              <input type="file" name="profile" accept=".mobileconfig" required>
              <input type="password" name="password" placeholder="Password to confirm" required>
              <button type="submit">Queue update (24h delay)</button>
            </form>
            <div class="status-msg"></div>\`;
        return \`<details class="profile-details">
          <summary><span class="mdm-status-\${escapeHtml(p.status)}">\${escapeHtml(p.status)}</span> \${escapeHtml(p.name)}</summary>
          \${restrictionsHtml}
          \${updateSection}
        </details>\`;
      }).join(""));
    }
  } else {
    parts.push('<div class="empty">Not MDM-enrolled.</div>');
  }

  el.innerHTML = parts.join("");

  // Rebuilt from scratch on every render, so listeners are attached
  // fresh here each time rather than once at page load - matches how
  // this whole section already gets redrawn on every loadHostStatus().
  el.querySelectorAll(".update-profile-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const profileUuid = form.getAttribute("data-profile-uuid");
      const statusEl = form.nextElementSibling;
      const fd = new FormData(form);
      try {
        await api(\`/api/config-profiles/\${encodeURIComponent(profileUuid)}\`, { method: "PATCH", body: fd });
        // Queued, not applied - loadHostStatus() re-render replaces this
        // very form with a "queued, applies in ~24h" note (see the
        // pendingChange branch above), which itself is the success
        // indicator; no separate message needed here.
        await loadHostStatus();
      } catch (err) {
        statusEl.textContent = "Failed to queue: " + err.message;
        statusEl.className = "status-msg error";
      }
    });
  });
}

// Rules is now ONE list, not two: Santa's actual enforced rules (static
// + dynamic, as before) PLUS a suggested row for every app-inventory
// entry with a real Team ID that doesn't have a rule yet - real code-
// signing data scanned locally on the Mac (AppInventoryScanner.swift,
// daemon-side, synced every 15 minutes), not from SimpleMDM's inventory
// API (which has none at all). A suggested row's Block/Allow buttons
// post straight to /api/rules, same endpoint the manual Add rule form
// below uses - clicking one is genuinely just adding a rule, same as
// typing an identifier by hand, just without having to find the Team ID
// in Terminal first.
async function loadRules() {
  const [staticRules, rules, pending, appInventory] = await Promise.all([
    api("/api/static-rules"),
    api("/api/rules"),
    api("/api/loosen-requests"),
    api("/api/app-inventory"),
  ]);
  const pendingByRuleId = Object.fromEntries(pending.map((p) => [p.rule_id, p]));
  const body = document.getElementById("rules-body");

  // StaticRules from santa-config.mobileconfig - permanent, tamper-
  // resistant, not editable from here at all (see staticRules.ts).
  // Shown first and visually dimmed so it's clear at a glance these
  // aren't dashboard-managed, but still shown - an empty-looking table
  // here previously made it look like Santa was enforcing nothing, when
  // e.g. Tor Browser's block was working the whole time.
  const staticRowsHtml = staticRules.map((r) => \`<tr class="static-rule">
    <td>\${escapeHtml(r.name)}</td>
    <td>\${escapeHtml(r.identifier)}</td>
    <td>\${r.rule_type}</td>
    <td class="policy-\${r.policy}">\${r.policy}</td>
    <td>profile (static)</td>
    <td><span class="pending-note" style="color:#6b6f78;">edit santa-config.mobileconfig</span></td>
  </tr>\`).join("");

  const dynamicRowsHtml = rules.map((r) => {
    const p = pendingByRuleId[r.id];
    const canLoosen = r.policy !== "REMOVE" && !p;
    let actionCell;
    if (p) {
      actionCell = \`<span class="pending-note">loosen queued, applies in \${timeUntil(p.applies_at)}</span> <button data-cancel="\${p.id}">Cancel</button>\`;
    } else if (canLoosen) {
      actionCell = \`<button data-loosen="\${r.id}">Request loosen</button>\`;
    } else {
      actionCell = "";
    }
    return \`<tr>
      <td>\${escapeHtml(r.notification_app_name) || '<span class="empty" style="padding:0;">unnamed</span>'}</td>
      <td>\${escapeHtml(r.identifier)}</td>
      <td>\${r.rule_type}</td>
      <td class="policy-\${r.policy}">\${r.policy}</td>
      <td>\${r.device_id ?? "all devices"}</td>
      <td>\${actionCell}</td>
    </tr>\`;
  }).join("");

  // Only TEAMID rules count as "already ruled" here - a suggestion row
  // only ever proposes a TEAMID rule (that's what a Team ID actually
  // is), so a BINARY/CDHASH/etc rule on the same identifier string
  // (astronomically unlikely, but not impossible) shouldn't suppress it.
  const ruledTeamIds = new Set(
    [...staticRules, ...rules].filter((r) => r.rule_type === "TEAMID").map((r) => r.identifier)
  );
  const seenSuggested = new Set();
  const suggestedRowsHtml = (appInventory || [])
    .filter((a) => {
      if (!a.team_id || ruledTeamIds.has(a.team_id) || seenSuggested.has(a.team_id)) return false;
      seenSuggested.add(a.team_id);
      return true;
    })
    .map((a) => \`<tr>
      <td>\${escapeHtml(a.name || a.bundle_id)}</td>
      <td>\${escapeHtml(a.team_id)}</td>
      <td>TEAMID</td>
      <td><span class="pending-note" style="color:#6b6f78;">not ruled</span></td>
      <td>scanned app</td>
      <td><button data-block-team-id="\${escapeHtml(a.team_id)}" data-app-name="\${escapeHtml(a.name || a.bundle_id)}">Block</button> <button data-allow-team-id="\${escapeHtml(a.team_id)}" data-app-name="\${escapeHtml(a.name || a.bundle_id)}">Allow</button></td>
    </tr>\`).join("");

  body.innerHTML = staticRowsHtml + dynamicRowsHtml + suggestedRowsHtml
    || '<tr><td colspan="6" class="empty">No rules and nothing scanned yet.</td></tr>';
}

// ContentGuard's scanning exclusions - now ONE list, not two: every
// bundle ID already excluded (static compiled baseline + dashboard-
// approved + pending) PLUS every other app SimpleMDM's inventory (or
// the hand-kept list of built-in Apple apps, knownApps.ts) knows about
// that isn't excluded yet, with a Whitelist button right there. Built
// as one bundle-ID-keyed map so an app already covered by the first
// group is never shown twice with a stray second "you could whitelist
// this" row.
async function loadContentGuardApps(host) {
  // No host -> the Worker falls back to DEFAULT_SIMPLEMDM_DEVICE_ID (this
  // project's one real Mac) - see softwareApi.ts's handleListInstalledSoftware.
  const qs = host ? \`?host=\${encodeURIComponent(host)}\` : "";
  const [staticApps, approved, pendingAdditions, apps, knownApps] = await Promise.all([
    api("/api/static-safe-apps"),
    api("/api/safe-apps"),
    api("/api/safe-app-additions"),
    api(\`/api/installed-software\${qs}\`),
    api("/api/known-apps"),
  ]);

  const rows = new Map();
  for (const s of staticApps || []) {
    rows.set(s.bundleId, { kind: "static", name: s.name, bundleId: s.bundleId });
  }
  for (const a of approved || []) {
    rows.set(a.bundle_id, { kind: "approved", name: a.name, bundleId: a.bundle_id, addedAt: a.added_at });
  }
  // A bundle ID already approved can never also be pending - the ratchet
  // itself guarantees that (requestAddSafeApp checks both
  // isSafeAppBundleIdApproved and hasActivePendingSafeAppAddition before
  // ever queuing a request) - so this never clobbers an "approved" entry
  // set just above.
  for (const p of pendingAdditions || []) {
    rows.set(p.bundle_id, { kind: "pending", name: p.name, bundleId: p.bundle_id, pendingId: p.id, appliesAt: p.applies_at });
  }

  // Pin knownApps.ts's curated Apple apps at the top, in their declared
  // order, ahead of whatever else Fleet reported - see this section's
  // own subtitle for why. Prefer Fleet's real row when it actually has
  // one for a given bundle ID; only synthesize a bare row when Fleet has
  // nothing for it at all. Real complaint, fixed here rather than by
  // re-narrowing the inventory fetch itself: Fleet's old getHostSoftware
  // call used the macos_applications=true param, which scoped results
  // to top-level /Applications entries - SimpleMDM's installed_apps has
  // no equivalent scoping param and reports every com.apple.* system
  // component it finds (background helpers, framework-hosted mini-apps,
  // etc.), not just things a human would recognize. knownApps.ts already
  // exists specifically to make every REAL, recognizable built-in Apple
  // app manageable by name - anything else still carrying a com.apple.*
  // bundle ID here is exactly the noise that curated list was meant to
  // make unnecessary to wade through, not a second category of app
  // anyone's actually going to whitelist.
  const appsByBundleId = new Map((apps || []).filter((a) => a.bundle_identifier).map((a) => [a.bundle_identifier, a]));
  const knownBundleIds = new Set((knownApps || []).map((k) => k.bundleId));
  const knownRows = (knownApps || []).map((k) => appsByBundleId.get(k.bundleId) || { name: k.name, bundle_identifier: k.bundleId });
  const restRows = (apps || []).filter(
    (a) => !a.bundle_identifier || (!knownBundleIds.has(a.bundle_identifier) && !a.bundle_identifier.startsWith("com.apple."))
  );
  let noIdCount = 0;
  for (const a of [...knownRows, ...restRows]) {
    if (a.bundle_identifier && rows.has(a.bundle_identifier)) continue; // already covered above
    // An app with no bundle ID at all can't be deduped by identifier -
    // give it a unique synthetic key so more than one doesn't collide in
    // the Map and silently disappear.
    const key = a.bundle_identifier || \`__no-bundle-id-\${noIdCount++}\`;
    rows.set(key, { kind: "available", name: a.name, bundleId: a.bundle_identifier });
  }

  renderContentGuardApps([...rows.values()]);
}

function renderContentGuardApps(rows) {
  const body = document.getElementById("safe-apps-body");
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nothing whitelisted and no installed apps returned.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r) => {
    let statusCell, actionCell;
    if (r.kind === "static") {
      statusCell = '<span class="pending-note" style="color:#6b6f78;">compiled baseline</span>';
      actionCell = '<span class="pending-note" style="color:#6b6f78;">edit Config.swift</span>';
    } else if (r.kind === "approved") {
      statusCell = timeAgo(r.addedAt);
      actionCell = \`<button class="danger" data-remove-safe-app="\${escapeHtml(r.bundleId)}">Remove</button>\`;
    } else if (r.kind === "pending") {
      statusCell = \`<span class="pending-note">queued, applies in \${timeUntil(r.appliesAt)}</span>\`;
      actionCell = \`<button data-cancel-safe-app-addition="\${r.pendingId}">Cancel</button>\`;
    } else if (!r.bundleId) {
      statusCell = '<span class="empty" style="padding:0;">not whitelisted</span>';
      actionCell = '<span class="pending-note" style="color:#6b6f78;">no bundle ID</span>';
    } else {
      statusCell = '<span class="empty" style="padding:0;">not whitelisted</span>';
      actionCell = \`<button data-whitelist="\${escapeHtml(r.bundleId)}" data-app-name="\${escapeHtml(r.name ?? "")}">Whitelist</button>\`;
    }
    return \`<tr\${r.kind === "static" ? ' class="static-rule"' : ""}>
      <td>\${r.name ? escapeHtml(r.name) : '<span class="empty" style="padding:0;">unknown</span>'}</td>
      <td>\${r.bundleId ? escapeHtml(r.bundleId) : '<span class="empty" style="padding:0;">—</span>'}</td>
      <td>\${statusCell}</td>
      <td>\${actionCell}</td>
    </tr>\`;
  }).join("");
}

async function loadSoftware() {
  const packages = await api("/api/software");
  const body = document.getElementById("software-body");
  if (packages.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nothing uploaded yet.</td></tr>';
    return;
  }
  body.innerHTML = packages.map((p) => \`<tr>
    <td>\${escapeHtml(p.name)}</td>
    <td>\${escapeHtml(p.version ?? "")}</td>
    <td>\${escapeHtml(p.platform ?? "")}</td>
    <td><button data-install="\${p.title_id}">Install on host...</button></td>
  </tr>\`).join("");
}

async function loadPendingPasswordChange() {
  const pending = await api("/api/password/pending-change");
  const note = document.getElementById("password-pending-note");
  if (!pending) {
    note.innerHTML = "";
    return;
  }
  note.innerHTML = \`<span class="pending-note">Password change queued, applies in \${timeUntil(pending.applies_at)}</span> <button data-cancel-password="\${pending.id}">Cancel</button>\`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function setStatus(id, message, isError) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = "status-msg" + (isError ? " error" : "");
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
  location.reload();
});

// Static, lives outside #mdm-lockdown-body on purpose (see the section's
// markup) - that container gets fully rebuilt by every loadHostStatus()
// call, including the one this handler itself triggers on success, so a
// listener attached inside renderMdmLockdown would either vanish or
// double up across renders. Attached once here instead, same as
// add-rule-form below.
document.getElementById("upload-profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/config-profiles", { method: "POST", body: fd });
    e.target.reset();
    await loadHostStatus();
    setStatus("upload-profile-status", "Queued - applies in ~24h, same as any other loosening on this dashboard.", false);
  } catch (err) {
    setStatus("upload-profile-status", "Failed to queue upload: " + err.message, true);
  }
});

// Static, same placement reasoning as upload-profile-form above -
// #profile-changes-pending lives outside #mdm-lockdown-body, and this
// handler itself calls loadHostStatus() on success.
document.getElementById("profile-changes-pending").addEventListener("click", async (e) => {
  const cancelId = e.target.getAttribute("data-cancel-profile-change");
  if (!cancelId) return;
  try {
    await api(\`/api/pending-profile-changes/\${cancelId}/cancel\`, { method: "POST" });
    await loadHostStatus();
  } catch (err) {
    setStatus("upload-profile-status", "Failed to cancel: " + err.message, true);
  }
});

document.getElementById("add-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identifier: form.get("identifier"),
        rule_type: form.get("rule_type"),
        policy: form.get("policy"),
        notification_app_name: form.get("app_name") || undefined,
      }),
    });
    e.target.reset();
    setStatus("rules-status", "Rule added.", false);
    await loadRules();
  } catch (err) {
    setStatus("rules-status", "Failed to add rule: " + err.message, true);
  }
});

// Handles Rules' own loosen/cancel actions AND a suggested row's
// Block/Allow (adding a brand-new TEAMID rule) - both now land in the
// same tbody, since Rules is one list, not two. See loadRules()'s own
// comment for why a suggested row's buttons just post straight to
// /api/rules, same as the manual Add rule form below.
document.getElementById("rules-body").addEventListener("click", async (e) => {
  const loosenId = e.target.getAttribute("data-loosen");
  const cancelId = e.target.getAttribute("data-cancel");
  const blockTeamId = e.target.getAttribute("data-block-team-id");
  const allowTeamId = e.target.getAttribute("data-allow-team-id");
  if (loosenId) {
    const password = prompt("Password to request loosening this rule:");
    if (!password) return;
    try {
      await api(\`/api/rules/\${loosenId}/loosen-request\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setStatus("rules-status", "Loosen queued - takes effect after the 24h delay.", false);
      await loadRules();
    } catch (err) {
      setStatus("rules-status", "Failed to request loosen: " + err.message, true);
    }
  } else if (cancelId) {
    try {
      await api(\`/api/loosen-requests/\${cancelId}/cancel\`, { method: "POST" });
      setStatus("rules-status", "Loosen request cancelled.", false);
      await loadRules();
    } catch (err) {
      setStatus("rules-status", "Failed to cancel: " + err.message, true);
    }
  } else if (blockTeamId || allowTeamId) {
    const teamId = blockTeamId || allowTeamId;
    const appName = e.target.getAttribute("data-app-name");
    const policy = blockTeamId ? "BLOCKLIST" : "ALLOWLIST";
    try {
      await api("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: teamId, rule_type: "TEAMID", policy, notification_app_name: appName || undefined }),
      });
      setStatus("rules-status", (blockTeamId ? "Blocked " : "Allowed ") + appName + ".", false);
      await loadRules();
    } catch (err) {
      setStatus("rules-status", "Failed to add rule: " + err.message, true);
    }
  }
});

// Bulk allowlisting - the actual point of the suggested rows (see
// loadRules()'s own comment): getting from "no allowlist at all" to
// "every app already on this Mac has a real ALLOWLIST Team ID rule" one
// click at a time would be tedious enough to defeat the purpose. Plain
// sequential client-side loop over /api/rules, same endpoint the
// single-row buttons above already use - no new bulk endpoint on the
// Worker side, same "minimal moving parts" reasoning as everywhere else
// in this project. Skips anything with no Team ID or already ruled
// (either policy) - this button only ever adds, never overrides an
// existing BLOCKLIST someone deliberately set.
document.getElementById("allow-all-app-inventory").addEventListener("click", async () => {
  if (!confirm("Queue an ALLOWLIST Team ID rule for every app below that doesn't have one yet?")) return;
  setStatus("rules-status", "Loading current state...", false);
  try {
    const [apps, staticRules, rules] = await Promise.all([
      api("/api/app-inventory"),
      api("/api/static-rules"),
      api("/api/rules"),
    ]);
    const ruledTeamIds = new Set(
      [...(staticRules || []), ...(rules || [])].filter((r) => r.rule_type === "TEAMID").map((r) => r.identifier)
    );
    const seen = new Set();
    const targets = (apps || []).filter((a) => {
      if (!a.team_id || ruledTeamIds.has(a.team_id) || seen.has(a.team_id)) return false;
      seen.add(a.team_id);
      return true;
    });
    if (targets.length === 0) {
      setStatus("rules-status", "Nothing to do - every scanned Team ID already has a rule.", false);
      return;
    }
    let done = 0;
    for (const a of targets) {
      setStatus("rules-status", \`Allowing \${a.name || a.bundle_id} (\${done + 1}/\${targets.length})...\`, false);
      await api("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: a.team_id, rule_type: "TEAMID", policy: "ALLOWLIST", notification_app_name: a.name || undefined }),
      });
      done++;
    }
    setStatus("rules-status", \`Allowed \${done} app(s).\`, false);
    await loadRules();
  } catch (err) {
    setStatus("rules-status", "Failed partway through: " + err.message, true);
    await loadRules();
  }
});

// Handles Safe apps' Remove, a pending addition's Cancel, and Whitelist
// (queuing a brand-new one) - all three now land in the same tbody,
// since this is one list, not two.
document.getElementById("safe-apps-body").addEventListener("click", async (e) => {
  const removeId = e.target.getAttribute("data-remove-safe-app");
  const cancelId = e.target.getAttribute("data-cancel-safe-app-addition");
  const whitelistId = e.target.getAttribute("data-whitelist");
  if (removeId) {
    try {
      await api(\`/api/safe-apps/\${encodeURIComponent(removeId)}\`, { method: "DELETE" });
      setStatus("safe-apps-status", "Removed - takes effect immediately.", false);
      await loadContentGuardApps();
    } catch (err) {
      setStatus("safe-apps-status", "Failed to remove: " + err.message, true);
    }
  } else if (cancelId) {
    try {
      await api(\`/api/safe-app-additions/\${cancelId}/cancel\`, { method: "POST" });
      setStatus("safe-apps-status", "Cancelled.", false);
      await loadContentGuardApps();
    } catch (err) {
      setStatus("safe-apps-status", "Failed to cancel: " + err.message, true);
    }
  } else if (whitelistId) {
    const appName = e.target.getAttribute("data-app-name");
    const password = prompt(\`Password to confirm whitelisting "\${appName}" (excluded from scanning, applies after 24h):\`);
    if (!password) return;
    try {
      await api("/api/safe-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle_id: whitelistId, name: appName, password }),
      });
      setStatus("safe-apps-status", "Whitelist queued for " + appName + " - applies in ~24h.", false);
      await loadContentGuardApps();
    } catch (err) {
      setStatus("safe-apps-status", "Failed to queue whitelist: " + err.message, true);
    }
  }
});

document.getElementById("load-apps-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const host = new FormData(e.target).get("host");
  try {
    setStatus("safe-apps-status", "Loading...", false);
    await loadContentGuardApps(host);
    setStatus("safe-apps-status", "", false);
  } catch (err) {
    setStatus("safe-apps-status", "Failed to load: " + err.message, true);
  }
});

// One list, same "static/approved plus pending" shape as ContentGuard's
// safe-apps table above - here there's no separate "static" tier
// (nothing pre-seeds blocked_keywords), just what's currently blocked
// and whatever's queued to stop being blocked.
async function loadKeywords() {
  const [blocked, pendingRemovals] = await Promise.all([
    api("/api/keywords"),
    api("/api/keyword-removals"),
  ]);
  const pendingByKeywordId = new Map((pendingRemovals || []).map((p) => [p.keyword_id, p]));
  renderKeywords((blocked || []).map((k) => ({ ...k, pending: pendingByKeywordId.get(k.id) })));
}

function renderKeywords(rows) {
  const body = document.getElementById("keywords-body");
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="3" class="empty">Nothing blocked yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const actionCell = r.pending
        ? \`Removal queued, applies in \${timeUntil(r.pending.applies_at)} <button data-cancel-keyword-removal="\${r.pending.id}">Cancel</button>\`
        : \`<button class="danger" data-remove-keyword="\${r.id}">Remove</button>\`;
      return \`<tr><td>\${escapeHtml(r.keyword)}</td><td>\${timeAgo(r.added_at)}</td><td>\${actionCell}</td></tr>\`;
    })
    .join("");
}

document.getElementById("add-keyword-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const keyword = new FormData(e.target).get("keyword");
  try {
    await api("/api/keywords", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    e.target.reset();
    setStatus("keywords-status", "Added - blocking immediately.", false);
    await loadKeywords();
  } catch (err) {
    setStatus("keywords-status", "Failed to add: " + err.message, true);
  }
});

// Removing a keyword is a loosening - same re-entered-password-plus-24h
// pattern as a Santa rule's loosen-request (rules-body's own click
// listener above); cancelling a queued removal needs no password, same
// reasoning as every other cancel-a-loosen action in this project.
document.getElementById("keywords-body").addEventListener("click", async (e) => {
  const removeId = e.target.getAttribute("data-remove-keyword");
  const cancelId = e.target.getAttribute("data-cancel-keyword-removal");
  if (removeId) {
    const password = prompt("Password to request removing this keyword:");
    if (!password) return;
    try {
      await api(\`/api/keywords/\${removeId}/removal-request\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setStatus("keywords-status", "Removal queued - takes effect after the 24h delay.", false);
      await loadKeywords();
    } catch (err) {
      setStatus("keywords-status", "Failed to request removal: " + err.message, true);
    }
  } else if (cancelId) {
    try {
      await api(\`/api/keyword-removals/\${cancelId}/cancel\`, { method: "POST" });
      setStatus("keywords-status", "Removal request cancelled.", false);
      await loadKeywords();
    } catch (err) {
      setStatus("keywords-status", "Failed to cancel: " + err.message, true);
    }
  }
});

// Uploads in R2-multipart chunks rather than one POST carrying the
// whole file - see softwareApi.ts's own top comment for why: a real
// upload found live (2026-09-04) was well over Cloudflare's ~100MB
// incoming-request-body limit, which the previous single-POST version
// of this handler hit silently - the request never reached the Worker
// at all, so nothing here ever ran to report an error; the button just
// appeared to do nothing. CHUNK_SIZE is comfortably above R2's own
// 5MB-minimum-part-size requirement (confirmed against Cloudflare's R2
// multipart docs) with room to spare.
const SOFTWARE_UPLOAD_CHUNK_SIZE = 20 * 1024 * 1024;

// Mirrors softwareApi.ts's own MAX_PROXIED_UPLOAD_BYTES - a client-side
// copy, not the enforcement itself (the Worker still checks for real in
// handleUploadComplete), purely so an oversized file is rejected
// instantly instead of after uploading the whole thing to R2 in chunks
// first only to be told "no" at the very last step. See that constant's
// own doc comment for why this ceiling exists at all: Cloudflare
// Workers' fetch() fully buffers a request body before sending it to an
// external origin (SimpleMDM's API here), a platform limit no amount of
// chunking on this end can work around.
const MAX_PROXIED_UPLOAD_BYTES = 80 * 1024 * 1024;

document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fileInput = e.target.querySelector("input[type=file]");
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > MAX_PROXIED_UPLOAD_BYTES) {
    const gotMb = (file.size / 1024 / 1024).toFixed(0);
    const maxMb = (MAX_PROXIED_UPLOAD_BYTES / 1024 / 1024).toFixed(0);
    setStatus(
      "software-status",
      \`Package is \${gotMb}MB, over this dashboard's \${maxMb}MB limit (a Cloudflare Workers platform limit, not a bug here). Upload it directly via SimpleMDM's own dashboard (a.simplemdm.com) instead.\`,
      true
    );
    return;
  }
  const submitBtn = e.target.querySelector("button[type=submit]");

  let key, uploadId;
  submitBtn.disabled = true;
  try {
    ({ key, uploadId } = await api("/api/software/upload-init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name }),
    }));

    const totalParts = Math.max(1, Math.ceil(file.size / SOFTWARE_UPLOAD_CHUNK_SIZE));
    const parts = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      setStatus("software-status", \`Uploading part \${partNumber}/\${totalParts}...\`, false);
      const start = (partNumber - 1) * SOFTWARE_UPLOAD_CHUNK_SIZE;
      const chunk = file.slice(start, start + SOFTWARE_UPLOAD_CHUNK_SIZE);
      const qs = \`key=\${encodeURIComponent(key)}&uploadId=\${encodeURIComponent(uploadId)}&partNumber=\${partNumber}\`;
      const part = await api(\`/api/software/upload-part?\${qs}\`, { method: "PUT", body: chunk });
      parts.push(part);
    }

    setStatus("software-status", "Finishing upload...", false);
    await api("/api/software/upload-complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, uploadId, parts, filename: file.name }),
    });

    e.target.reset();
    setStatus("software-status", "Package uploaded.", false);
    await loadSoftware();
  } catch (err) {
    setStatus("software-status", "Upload failed: " + err.message, true);
    if (key && uploadId) {
      api("/api/software/upload-abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, uploadId }),
      }).catch(() => undefined);
    }
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("software-body").addEventListener("click", async (e) => {
  const titleId = e.target.getAttribute("data-install");
  if (!titleId) return;
  const host = prompt("Hostname, serial, or UUID of the target host:");
  if (!host) return;
  try {
    await api(\`/api/software/\${titleId}/install\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host }),
    });
    setStatus("software-status", "Install requested on " + host + ".", false);
  } catch (err) {
    setStatus("software-status", "Install failed: " + err.message, true);
  }
});

document.getElementById("change-login-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/api/login-password/change", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        current_password: form.get("current_password"),
        new_password: form.get("new_password"),
      }),
    });
    e.target.reset();
    setStatus("login-password-status", "Login password changed.", false);
  } catch (err) {
    setStatus("login-password-status", "Failed to change: " + err.message, true);
  }
});

document.getElementById("change-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/api/password/change-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        current_password: form.get("current_password"),
        new_password: form.get("new_password"),
      }),
    });
    e.target.reset();
    setStatus("password-status", "Change queued - takes effect after the 24h delay.", false);
    await loadPendingPasswordChange();
  } catch (err) {
    setStatus("password-status", "Failed to request change: " + err.message, true);
  }
});

document.getElementById("password-pending-note").addEventListener("click", async (e) => {
  const cancelId = e.target.getAttribute("data-cancel-password");
  if (!cancelId) return;
  try {
    await api(\`/api/password/change-request/\${cancelId}/cancel\`, { method: "POST" });
    setStatus("password-status", "Password change cancelled.", false);
    await loadPendingPasswordChange();
  } catch (err) {
    setStatus("password-status", "Failed to cancel: " + err.message, true);
  }
});

// Tab nav - plain show/hide, no router needed for three tabs. The
// current tab lives in the URL hash so it survives a reload/bookmark,
// same "no build step, no extra moving parts" reasoning as everything
// else in this file.
const TABS = ["mac", "android", "networking", "access-map", "architecture"];
function showTab(name) {
  if (!TABS.includes(name)) name = "mac";
  TABS.forEach((t) => {
    document.getElementById(\`tab-\${t}\`).hidden = t !== name;
  });
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === name);
  });
}
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    location.hash = btn.getAttribute("data-tab");
  });
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

loadRules().catch((err) => setStatus("rules-status", "Failed to load rules: " + err.message, true));
loadContentGuardApps().catch((err) => setStatus("safe-apps-status", "Failed to load: " + err.message, true));
loadKeywords().catch((err) => setStatus("keywords-status", "Failed to load: " + err.message, true));
loadSoftware().catch((err) => setStatus("software-status", "Failed to load software: " + err.message, true));
loadPendingPasswordChange().catch(() => {});
loadHostStatus().catch((err) => {
  document.getElementById("sync-health-body").innerHTML = \`<div class="empty error">Failed to load: \${escapeHtml(err.message)}</div>\`;
  document.getElementById("mdm-lockdown-body").innerHTML = "";
});
</script>
</body>
</html>`;
}
