// Second half of keyword blocking - the first half (declarativeNetRequest
// dynamic rules, background/service-worker.js) blocks navigation before
// any content loads for a keyword that appears in the URL itself. This
// content script exists for the case that doesn't cover: a keyword that
// only appears in the page's rendered text or title, not its URL. Runs
// at document_start (manifest.json) so the MutationObserver below is
// attached before the page has painted anything, but the actual keyword
// match can only happen once real text exists in the DOM - there IS a
// real, accepted exposure window between navigation and the first
// matching scan, which is exactly why the user's own answer to this
// project's "how should keyword matching work" question (2026-08-25)
// picked "URL + page text" over "page text only" - the URL layer catches
// what it can with zero exposure, this layer is the fallback for what it
// can't.

(() => {
  let keywords = [];
  let matched = false;
  // The dashboard (this project's own Worker, chrome.storage.local's
  // workerUrl - same value options.js saves) necessarily renders every
  // blocked keyword as plain page text: the Keyword blocker section's
  // whole job is showing what's on the list. Scanning that page against
  // its own list would block the one page used to manage the list the
  // moment a real keyword goes on it - not a hypothetical, this is what
  // actually happened. Real exemption, not a loophole: this only ever
  // matches the one origin this same extension is configured to sync
  // from, set via the options page, not something a blocked site could
  // spoof its way into.
  let exempt = false;

  function normalize(text) {
    return text.toLowerCase();
  }

  function scan() {
    if (exempt || matched || keywords.length === 0) return;
    // document.title first (cheap, always available even before body
    // finishes parsing) then body text - checking title separately
    // means a match there fires without waiting on a possibly-huge
    // body.innerText computation.
    const haystacks = [document.title, document.body ? document.body.innerText : ""];
    for (const haystack of haystacks) {
      if (!haystack) continue;
      const normalized = normalize(haystack);
      for (const keyword of keywords) {
        if (normalized.includes(keyword)) {
          matched = true;
          chrome.runtime.sendMessage({ type: "contentguard-keyword-match", keyword });
          return;
        }
      }
    }
  }

  // Debounced, not run on every single mutation - a busy page (chat
  // apps, live feeds) can mutate the DOM dozens of times a second, and
  // this only needs to notice a match within a human-perceptible delay,
  // not instantly on every character typed somewhere on the page.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled || matched || exempt) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 500);
  }

  // workerUrl's *origin* is what's compared, not a substring/prefix
  // match - exact scheme+host+port, same precision new URL(...).origin
  // gives service-worker.js's own DNR rule exemption (see that file's
  // syncKeywords), so the two enforcement paths can't drift apart on
  // what counts as "the panel".
  function computeExempt(workerUrl) {
    if (!workerUrl) return false;
    try {
      return new URL(workerUrl).origin === location.origin;
    } catch {
      return false; // malformed value in storage - fail toward still scanning, never toward a silent bypass
    }
  }

  chrome.storage.local.get(["keywords", "workerUrl"], (stored) => {
    keywords = Array.isArray(stored.keywords) ? stored.keywords : [];
    exempt = computeExempt(stored.workerUrl);
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.keywords) {
      keywords = Array.isArray(changes.keywords.newValue) ? changes.keywords.newValue : [];
      matched = false; // A newly-added keyword should be checked against
      // content already on the page, not just future changes.
    }
    if (changes.workerUrl) {
      exempt = computeExempt(changes.workerUrl.newValue);
    }
    if (changes.keywords || changes.workerUrl) scan();
  });

  const observer = new MutationObserver(scheduleScan);
  // documentElement always exists at document_start even before <body> -
  // observing it (not document.body, which may not exist yet) so no
  // early content is missed.
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Covers the case keywords load (from storage.get above) after the
  // initial DOM is already fully parsed and no further mutations happen
  // to trigger scheduleScan on their own.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }
})();
