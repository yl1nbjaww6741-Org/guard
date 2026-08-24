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

export function renderLoginPage(errorMessage?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ContentGuard Control Panel</title>
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
<script>
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
<title>ContentGuard Control Panel</title>
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
  </nav>

  <div id="tab-mac" class="tab-panel">

  <section>
    <h2>Sync health</h2>
    <div class="subtitle" style="margin-bottom: 0;">Two separate signals, on purpose - a Mac can be Fleet-online while Santa's sync is stalled, or vice versa.</div>
    <div id="sync-health-body">Loading...</div>
  </section>

  <section>
    <h2>MDM lockdown (Fleet)</h2>
    <div class="subtitle" style="margin-bottom: 0;">What Fleet has actually confirmed applied, not just what profiles/ intends.</div>
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
    <h2>Santa rules</h2>
    <table id="rules-table">
      <thead><tr><th>Name</th><th>Identifier</th><th>Type</th><th>Policy</th><th>Scope</th><th></th></tr></thead>
      <tbody id="rules-body"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
    </table>
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
    <h2>Safe apps (not scanned)</h2>
    <div class="subtitle" style="margin-bottom: 0;">Bundle IDs ContentGuardDaemon excludes from screen-capture monitoring, in addition to the compiled baseline in Config.swift - every entry here is a blind spot, kept short and deliberate. Adding one takes effect after a 24h delay, same as loosening a Santa rule; removing one is immediate.</div>
    <table id="safe-apps-table">
      <thead><tr><th>Bundle ID</th><th>Added</th><th></th></tr></thead>
      <tbody id="safe-apps-body"><tr><td colspan="3" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="add-safe-app-form">
      <input name="bundle_id" placeholder="Bundle ID (e.g. com.example.app)" required style="flex: 1; min-width: 220px;">
      <input type="password" name="password" placeholder="Password to confirm" required style="min-width: 160px;">
      <button type="submit">Queue add (24h delay)</button>
    </form>
    <div class="status-msg" id="safe-apps-status"></div>
    <div id="safe-app-additions-pending"></div>
  </section>

  <section>
    <h2>Installed apps</h2>
    <div class="subtitle" style="margin-bottom: 0;">Pulled from Fleet's own inventory - one click to block or allow, instead of manually finding a Team ID in Terminal.</div>
    <table id="installed-apps-table">
      <thead><tr><th>Name</th><th>Version</th><th>Detected identifier</th><th></th></tr></thead>
      <tbody id="installed-apps-body"><tr><td colspan="4" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="load-apps-form">
      <input name="host" placeholder="Different host? (hostname, serial, or UUID)" style="flex: 1; min-width: 220px;">
      <button type="submit">Load</button>
    </form>
    <div class="status-msg" id="installed-apps-status"></div>
  </section>

  <section>
    <h2>Software (Fleet)</h2>
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
    <h2>Change password</h2>
    <div id="password-pending-note"></div>
    <form class="inline" id="change-password-form">
      <input type="password" name="current_password" placeholder="Current password" required>
      <input type="password" name="new_password" placeholder="New password" required>
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

<script>
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

// Santa's sync freshness (devices.last_preflight_at) and Fleet's own
// online/offline status are genuinely different signals - see
// hostStatus.ts's doc comment. Both shown here, neither substituting
// for the other. 30 minutes is 3x Santa's own FullSyncInterval (10
// minutes, confirmed via santactl status on the real Mac) - comfortably
// past due before flagging it stale, not a hair-trigger on normal sync
// jitter.
const SANTA_STALE_MS = 30 * 60 * 1000;

function renderSyncHealth(data) {
  const el = document.getElementById("sync-health-body");
  const rows = [];

  if (data.fleet) {
    const online = data.fleet.status === "online";
    rows.push(\`<div class="status-row\${online ? "" : " error"}"><span class="status-dot" style="background:\${online ? "#51cf66" : "#ff6b6b"}"></span><strong>Fleet</strong>&nbsp;- \${escapeHtml(data.fleet.status)}, last seen \${timeAgo(data.fleet.seen_time)}</div>\`);
  } else {
    rows.push(\`<div class="status-row error"><span class="status-dot" style="background:#ff6b6b"></span><strong>Fleet</strong>&nbsp;- \${escapeHtml(data.fleetError ?? "not available")}</div>\`);
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
    parts.push(\`<div class="status-row\${f.mdm.connected_to_fleet ? "" : " error"}">MDM enrollment: \${escapeHtml(f.mdm.enrollment_status)}\${f.mdm.connected_to_fleet ? "" : " (NOT connected to Fleet)"}</div>\`);
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

async function loadRules() {
  const [staticRules, rules, pending] = await Promise.all([
    api("/api/static-rules"),
    api("/api/rules"),
    api("/api/loosen-requests"),
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

  let dynamicRowsHtml;
  if (rules.length === 0) {
    dynamicRowsHtml = '<tr><td colspan="6" class="empty">No dashboard-added rules yet.</td></tr>';
  } else {
    dynamicRowsHtml = rules.map((r) => {
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
  }

  body.innerHTML = staticRowsHtml + dynamicRowsHtml;
}

async function loadSafeApps() {
  const [approved, pending] = await Promise.all([
    api("/api/safe-apps"),
    api("/api/safe-app-additions"),
  ]);
  renderSafeApps(approved);
  renderSafeAppAdditionsPending(pending);
}

function renderSafeApps(approved) {
  const body = document.getElementById("safe-apps-body");
  if (approved.length === 0) {
    body.innerHTML = '<tr><td colspan="3" class="empty">No dashboard-added safe apps yet - the compiled baseline in Config.swift still applies regardless.</td></tr>';
    return;
  }
  body.innerHTML = approved.map((a) => \`<tr>
    <td>\${escapeHtml(a.bundle_id)}</td>
    <td>\${timeAgo(a.added_at)}</td>
    <td><button class="danger" data-remove-safe-app="\${escapeHtml(a.bundle_id)}">Remove</button></td>
  </tr>\`).join("");
}

// Static, lives outside #safe-apps-body on purpose - same reasoning as
// #profile-changes-pending: that table gets fully rebuilt on every
// loadSafeApps() call, including the one a successful add/cancel here
// itself triggers, so a listener attached inside renderSafeApps would
// either vanish or double up across renders.
function renderSafeAppAdditionsPending(pending) {
  const el = document.getElementById("safe-app-additions-pending");
  if (!pending || pending.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = pending.map((p) =>
    \`<div class="status-row">Add "\${escapeHtml(p.bundle_id)}": <span class="pending-note">queued, applies in \${timeUntil(p.applies_at)}</span> <button data-cancel-safe-app-addition="\${p.id}">Cancel</button></div>\`
  ).join("");
}

async function loadInstalledApps(host) {
  // No host -> the Worker falls back to DEFAULT_FLEET_HOST (this
  // project's one real Mac) - see softwareApi.ts's handleListInstalledSoftware.
  const qs = host ? \`?host=\${encodeURIComponent(host)}\` : "";
  const apps = await api(\`/api/installed-software\${qs}\`);
  const body = document.getElementById("installed-apps-body");
  if (apps.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="empty">No installed apps returned - Fleet may not have inventoried this host recently.</td></tr>';
    return;
  }
  body.innerHTML = apps.map((a) => {
    const idCell = a.identifier
      ? \`\${escapeHtml(a.identifier)} <span class="pending-note" style="color:#8b8f98;">(\${a.rule_type})</span>\`
      : '<span class="empty" style="padding:0;">no identifier available</span>';
    const actions = a.identifier
      ? \`<button data-block="\${escapeHtml(a.identifier)}" data-rule-type="\${a.rule_type}" data-app-name="\${escapeHtml(a.name)}">Block</button> <button data-allow="\${escapeHtml(a.identifier)}" data-rule-type="\${a.rule_type}" data-app-name="\${escapeHtml(a.name)}">Allow</button>\`
      : "";
    return \`<tr>
      <td>\${escapeHtml(a.name)}</td>
      <td>\${escapeHtml(a.version ?? "")}</td>
      <td>\${idCell}</td>
      <td>\${actions}</td>
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

document.getElementById("rules-body").addEventListener("click", async (e) => {
  const loosenId = e.target.getAttribute("data-loosen");
  const cancelId = e.target.getAttribute("data-cancel");
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
  }
});

// Static, same placement reasoning as upload-profile-form above.
document.getElementById("add-safe-app-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/api/safe-apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: form.get("bundle_id"), password: form.get("password") }),
    });
    e.target.reset();
    setStatus("safe-apps-status", "Queued - applies in ~24h, same as any other loosening on this dashboard.", false);
    await loadSafeApps();
  } catch (err) {
    setStatus("safe-apps-status", "Failed to queue: " + err.message, true);
  }
});

document.getElementById("safe-apps-body").addEventListener("click", async (e) => {
  const bundleId = e.target.getAttribute("data-remove-safe-app");
  if (!bundleId) return;
  try {
    await api(\`/api/safe-apps/\${encodeURIComponent(bundleId)}\`, { method: "DELETE" });
    setStatus("safe-apps-status", "Removed - takes effect immediately.", false);
    await loadSafeApps();
  } catch (err) {
    setStatus("safe-apps-status", "Failed to remove: " + err.message, true);
  }
});

// Static, same placement reasoning as profile-changes-pending above.
document.getElementById("safe-app-additions-pending").addEventListener("click", async (e) => {
  const cancelId = e.target.getAttribute("data-cancel-safe-app-addition");
  if (!cancelId) return;
  try {
    await api(\`/api/safe-app-additions/\${cancelId}/cancel\`, { method: "POST" });
    setStatus("safe-apps-status", "Cancelled.", false);
    await loadSafeApps();
  } catch (err) {
    setStatus("safe-apps-status", "Failed to cancel: " + err.message, true);
  }
});

document.getElementById("load-apps-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const host = new FormData(e.target).get("host");
  try {
    setStatus("installed-apps-status", "Loading...", false);
    await loadInstalledApps(host);
    setStatus("installed-apps-status", "", false);
  } catch (err) {
    setStatus("installed-apps-status", "Failed to load: " + err.message, true);
  }
});

document.getElementById("installed-apps-body").addEventListener("click", async (e) => {
  const blockId = e.target.getAttribute("data-block");
  const allowId = e.target.getAttribute("data-allow");
  const identifier = blockId || allowId;
  if (!identifier) return;
  const ruleType = e.target.getAttribute("data-rule-type");
  const appName = e.target.getAttribute("data-app-name");
  const policy = blockId ? "BLOCKLIST" : "ALLOWLIST";
  try {
    await api("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, rule_type: ruleType, policy, notification_app_name: appName || undefined }),
    });
    setStatus("installed-apps-status", (blockId ? "Blocked " : "Allowed ") + appName + ".", false);
    await loadRules();
  } catch (err) {
    setStatus("installed-apps-status", "Failed to add rule: " + err.message, true);
  }
});

document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api("/api/software", { method: "POST", body: form });
    e.target.reset();
    setStatus("software-status", "Package uploaded.", false);
    await loadSoftware();
  } catch (err) {
    setStatus("software-status", "Upload failed: " + err.message, true);
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
const TABS = ["mac", "android", "networking"];
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
loadSafeApps().catch((err) => setStatus("safe-apps-status", "Failed to load: " + err.message, true));
loadSoftware().catch((err) => setStatus("software-status", "Failed to load software: " + err.message, true));
loadPendingPasswordChange().catch(() => {});
loadInstalledApps().catch((err) => setStatus("installed-apps-status", "Failed to load: " + err.message, true));
loadHostStatus().catch((err) => {
  document.getElementById("sync-health-body").innerHTML = \`<div class="empty error">Failed to load: \${escapeHtml(err.message)}</div>\`;
  document.getElementById("mdm-lockdown-body").innerHTML = "";
});
</script>
</body>
</html>`;
}
