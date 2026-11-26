// Countdown for the repeat-offence lockout (see the "Repeat-offence
// lockout" section of background/service-worker.js). Purely a display:
// enforcement is the service worker's DNR redirect + tab listeners, so
// nothing this page does (or fails to do) can shorten the lockout.
const countdownEl = document.getElementById("countdown");
const untilEl = document.getElementById("until");
const whyEl = document.getElementById("why");

let lockoutUntil = 0;

function render() {
  const remaining = lockoutUntil - Date.now();
  if (remaining <= 0) {
    countdownEl.textContent = "0:00";
    whyEl.textContent = "The lockout is over.";
    untilEl.textContent = "You can close this tab.";
    return;
  }
  const totalSeconds = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, "0");
  countdownEl.textContent = `${m}:${s}`;
  untilEl.textContent = `Unlocks at ${new Date(lockoutUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

chrome.storage.local.get(["lockoutUntil"], (stored) => {
  lockoutUntil = stored.lockoutUntil || 0;
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lockoutUntil) {
    lockoutUntil = changes.lockoutUntil.newValue || 0;
    render();
  }
});
setInterval(render, 1000);
