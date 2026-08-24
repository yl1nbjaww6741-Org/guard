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

  <section>
    <h2>Santa rules</h2>
    <table id="rules-table">
      <thead><tr><th>Identifier</th><th>Type</th><th>Policy</th><th>Scope</th><th></th></tr></thead>
      <tbody id="rules-body"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
    </table>
    <form class="inline" id="add-rule-form">
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
    <td>\${escapeHtml(r.identifier)}</td>
    <td>\${r.rule_type}</td>
    <td class="policy-\${r.policy}">\${r.policy}</td>
    <td>profile (static)</td>
    <td><span class="pending-note" style="color:#6b6f78;">edit santa-config.mobileconfig</span></td>
  </tr>\`).join("");

  let dynamicRowsHtml;
  if (rules.length === 0) {
    dynamicRowsHtml = '<tr><td colspan="5" class="empty">No dashboard-added rules yet.</td></tr>';
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
      ? \`<button data-block="\${escapeHtml(a.identifier)}" data-rule-type="\${a.rule_type}">Block</button> <button data-allow="\${escapeHtml(a.identifier)}" data-rule-type="\${a.rule_type}">Allow</button>\`
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
  const policy = blockId ? "BLOCKLIST" : "ALLOWLIST";
  try {
    await api("/api/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, rule_type: ruleType, policy }),
    });
    setStatus("installed-apps-status", (blockId ? "Blocked " : "Allowed ") + identifier + ".", false);
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

loadRules().catch((err) => setStatus("rules-status", "Failed to load rules: " + err.message, true));
loadSoftware().catch((err) => setStatus("software-status", "Failed to load software: " + err.message, true));
loadPendingPasswordChange().catch(() => {});
loadInstalledApps().catch((err) => setStatus("installed-apps-status", "Failed to load: " + err.message, true));
</script>
</body>
</html>`;
}
