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

  function normalize(text) {
    return text.toLowerCase();
  }

  function scan() {
    if (matched || keywords.length === 0) return;
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
    if (scanScheduled || matched) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scan();
    }, 500);
  }

  chrome.storage.local.get(["keywords"], (stored) => {
    keywords = Array.isArray(stored.keywords) ? stored.keywords : [];
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.keywords) {
      keywords = Array.isArray(changes.keywords.newValue) ? changes.keywords.newValue : [];
      matched = false; // A newly-added keyword should be checked against
      // content already on the page, not just future changes.
      scan();
    }
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
