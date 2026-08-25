// Reads/writes { workerUrl, syncToken } to chrome.storage.local -
// deliberately local, not chrome.storage.sync: this project has exactly
// one real user/one real Mac in scope (same "single-operator design"
// reasoning the dashboard's own dashboard_auth table comment states),
// and syncing a secret token across every Chrome profile signed into the
// same Google account is a strictly worse privacy/security posture than
// keeping it on this one machine only.

const workerUrlInput = document.getElementById("worker-url");
const syncTokenInput = document.getElementById("sync-token");
const statusEl = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.local.get(["workerUrl", "syncToken"]);
  if (stored.workerUrl) workerUrlInput.value = stored.workerUrl;
  if (stored.syncToken) syncTokenInput.value = stored.syncToken;
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const workerUrl = workerUrlInput.value.trim().replace(/\/+$/, "");
  const syncToken = syncTokenInput.value.trim();
  if (!workerUrl || !syncToken) {
    statusEl.textContent = "Both fields are required.";
    statusEl.className = "status err";
    return;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(workerUrl);
  } catch {
    statusEl.textContent = "Worker URL doesn't look like a valid URL.";
    statusEl.className = "status err";
    return;
  }
  await chrome.storage.local.set({ workerUrl, syncToken });
  // Background service worker's own storage.onChanged listener (see
  // service-worker.js) picks this up and triggers an immediate sync -
  // no need to message it directly here.
  statusEl.textContent = "Saved - syncing now.";
  statusEl.className = "status ok";
});

load();
