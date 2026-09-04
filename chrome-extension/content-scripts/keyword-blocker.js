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
//
// Re-added 2026-09-04 after a brief full removal (see git history for
// 30a332e) - unchanged from before that removal, since the two things
// the removal was really standing in for were already true here and
// just needed to be guaranteed deliberately, not patched in fresh:
//  - FULL-PHRASE-ONLY MATCHING, explicit user requirement: scan() below
//    does haystack.includes(keyword) against the ENTIRE stored keyword
//    string, never a per-word split or prefix check - a keyword like
//    "reddit media downloader" can only ever match that exact
//    contiguous phrase, never "reddit" or "reddit media" appearing
//    alone on some unrelated page. keywordsApi.ts's handleAddKeyword
//    stores the whole trimmed/lowercased phrase as one indivisible
//    string server-side too, so there's no point in this pipeline where
//    a multi-word keyword ever gets decomposed into individual words.
//  - PANEL EXEMPTION, explicit user requirement: this scan never runs
//    against this project's own dashboard - see the `exempt` constant
//    just below for the mechanism.
//
// Simplified 2026-09-04, same day as the sync-token removal
// (background/service-worker.js's own header comment): the panel origin
// used to come from chrome.storage.local's workerUrl (options page,
// same value the extension synced keywords from) - now it's the
// hardcoded CONTENTGUARD_PANEL_URL constant (shared/config.js, loaded
// before this file per manifest.json's content_scripts order), a plain
// compile-time value rather than something read from storage on every
// page load.
//
// WORD-BOUNDARY MATCHING added 2026-09-04, explicit user requirement,
// and deliberately ONLY here - service-worker.js's urlFilter rule
// (the URL half of keyword blocking) is untouched, still a plain
// substring match, per that same explicit instruction ("only make it
// for words on the screen, not the link").
//
// "Full-phrase matching" (this file's header above, unchanged in
// meaning) was never the same guarantee as word-boundary matching -
// haystack.includes(keyword) only ever guaranteed a multi-word keyword
// couldn't match on a PARTIAL word of itself (e.g. "reddit" alone
// couldn't trigger "reddit media downloader"). It said nothing about
// the keyword appearing embedded inside a longer, unrelated word - a
// real, concrete problem for a short keyword specifically: "milf"
// plain-substring-matched "Milford" (a common place name - Milford CT/
// PA/DE/MA/OH, Milford Sound/Track in NZ) and "milfoil" (a real aquatic
// plant); "pussy" matched "pussycat"/"pussyfoot"/"pussy willow". Found
// and worked through with the user BEFORE either word was ever added
// live, not after a real false-positive - see this file's own git
// history for the analysis.
//
// buildKeywordPattern() below wraps the WHOLE stored phrase in \b
// (word-boundary) anchors, at the start and end only - a multi-word
// keyword's internal spaces are still matched as plain literal
// characters, unchanged, so "reddit media downloader" still requires
// that exact contiguous run of words ("connected", per the user's own
// phrasing) with nothing else glued onto either end of the phrase as a
// single word. \b itself is JS regex's own word/non-word character
// transition, confirmed via MDN - it treats [A-Za-z0-9_] as "word"
// characters and everything else (spaces, punctuation, start/end of
// string) as non-word, which is exactly the boundary "milf" needs
// against the "o" in "Milford" but "reddit media downloader"'s own
// internal spaces never trip (a space is already non-word on both
// sides, so \b never anchors there in the first place - only at the
// very start of "reddit" and the very end of "downloader").

(() => {
  // {keyword, pattern} pairs, compiled once whenever the stored keyword
  // list changes (not per-scan) - scan() runs on a 500ms debounce off a
  // MutationObserver that can fire often on a busy page, so building a
  // fresh RegExp per keyword per scan would be wasted work; the list
  // itself only ever changes on load or storage.onChanged, both rare.
  let keywordPatterns = [];
  let matched = false;

  // Escapes every regex-special character so a keyword like "y2k?" or
  // "c++" is matched as those literal characters, not interpreted as
  // regex syntax - standard escaping set (confirmed against MDN's own
  // RegExp guide), applied before wrapping in \b below.
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // \b anchors the WHOLE phrase's two ends only, not each individual
  // word inside it - a multi-word keyword's own internal spaces are
  // still plain literal characters, matched as one contiguous run
  // exactly as before ("connected", per the user's own requirement).
  // See this file's own top comment for why \b matters at all: it's
  // what stops a short keyword like "milf" from matching inside a
  // longer, unrelated word like "Milford".
  function buildKeywordPattern(keyword) {
    return new RegExp(`\\b${escapeRegExp(keyword)}\\b`);
  }

  function compileKeywords(rawKeywords) {
    return (Array.isArray(rawKeywords) ? rawKeywords : []).map((keyword) => ({
      keyword,
      pattern: buildKeywordPattern(keyword),
    }));
  }

  // The dashboard (this project's own Worker) necessarily renders every
  // blocked keyword as plain page text: the Keyword blocker section's
  // whole job is showing what's on the list. Scanning that page against
  // its own list would block the one page used to manage the list the
  // moment a real keyword goes on it - not a hypothetical, this is what
  // actually happened. Real exemption, not a loophole: this only ever
  // matches CONTENTGUARD_PANEL_URL's own origin, a value baked into this
  // extension's own source, not something a blocked site could spoof
  // its way into.
  //
  // CONTENTGUARD_PANEL_URL's *origin* is what's compared, not a
  // substring/prefix match - exact scheme+host+port, same precision
  // service-worker.js's
  // own DNR rule exemption uses (that file's PANEL_HOSTNAME), so the two
  // enforcement paths can't drift apart on what counts as "the panel".
  // Computed once, not per-scan - CONTENTGUARD_PANEL_URL never changes
  // at runtime.
  const exempt = new URL(CONTENTGUARD_PANEL_URL).origin === location.origin;

  function normalize(text) {
    return text.toLowerCase();
  }

  function scan() {
    if (exempt || matched || keywordPatterns.length === 0) return;
    // document.title first (cheap, always available even before body
    // finishes parsing) then body text - checking title separately
    // means a match there fires without waiting on a possibly-huge
    // body.innerText computation.
    const haystacks = [document.title, document.body ? document.body.innerText : ""];
    for (const haystack of haystacks) {
      if (!haystack) continue;
      const normalized = normalize(haystack);
      for (const { keyword, pattern } of keywordPatterns) {
        if (pattern.test(normalized)) {
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

  chrome.storage.local.get(["keywords"], (stored) => {
    keywordPatterns = compileKeywords(stored.keywords);
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.keywords) return;
    keywordPatterns = compileKeywords(changes.keywords.newValue);
    matched = false; // A newly-added keyword should be checked against
    // content already on the page, not just future changes.
    scan();
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
