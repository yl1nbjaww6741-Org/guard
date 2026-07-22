package com.contentguard.app.detect

/**
 * Gate 4 of the cascade: browser-agnostic detection of private/incognito
 * browsing.
 *
 * This exists as the answer to a real limitation elsewhere in the cascade:
 * browsers set FLAG_SECURE on private/incognito windows specifically to
 * block screenshots and screen recording, which also blocks
 * AccessibilityService.takeScreenshot() with no exception for
 * accessibility services - so gates 5/6/7 (capture, skin-tone prefilter,
 * NN classifier) structurally cannot see anything in a private tab, ever.
 * Detecting the *presence* of private browsing from the accessibility
 * tree's text instead of trying to inspect its pixel content sidesteps
 * that entirely, since the semantic accessibility tree itself is not
 * blocked by FLAG_SECURE - only the rendering/capture pipeline is.
 *
 * Real-world testing found the first version of this (keyword-matching the
 * *entire* accessibility tree's concatenated text, with no package
 * restriction) false-positived on ordinary Chrome browsing and even on
 * Gboard. Two separate causes:
 *
 * 1. [BROWSER_PACKAGES] didn't exist - any app could trigger this. Gboard
 *    genuinely does show its own "Incognito mode" privacy indicator
 *    whenever the field it's typing into is flagged private (in any app,
 *    not just a browser), and this codebase has hit the general "IME
 *    window briefly looks like the foreground package" bug class before
 *    (see SETUP.md) - so Gboard's own window occasionally got checked and
 *    matched. Restricting to known browser packages rules this out
 *    entirely regardless of what Gboard's own UI says.
 * 2. Scanning the *whole* node tree concatenates every node's text/content
 *    description into one blob separated by single spaces
 *    (NodeInspector.scan), with no regard for which nodes are actually
 *    related - so two unrelated pieces of UI text sitting next to each
 *    other in traversal order can accidentally form a matching phrase.
 *    Worse, Chrome's own tab-switcher button reports an incognito tab
 *    *count* in its content description even when that count is zero, so
 *    the bare word "incognito" was present somewhere in the tree on
 *    ordinary, non-incognito pages too. [CONTENT_KEYWORDS] (used against
 *    that whole-tree text) is deliberately narrower than [TITLE_KEYWORDS]
 *    (used against the window's own title, a single short string with no
 *    concatenation risk) for exactly this reason - see [matchingContentKeyword].
 *
 * Deliberately no Settings toggle to disable this - the whole point is
 * that private/incognito mode can't be used to evade the rest of the
 * cascade, so it can't have an easy in-app off switch any more than the
 * password-gated Settings/Accessibility screens do.
 */
object IncognitoDetector {

    /**
     * Only these packages are ever checked - not because the text
     * signals couldn't in principle appear elsewhere, but because
     * restricting to known browsers is what keeps this from ever firing
     * on an unrelated app (Gboard, or anything else) no matter what text
     * transiently appears in its own accessibility tree.
     *
     * Chrome's own package IDs were previously pulled out of this set -
     * real-device testing kept reporting Chrome fully blocked even after
     * the title check was confirmed correct in isolation (GATE4_TITLE_DEBUG
     * showed "Chrome: New tab" not matching and "Chrome: New Incognito tab"
     * matching, exactly as intended). Root cause found on closer read of
     * [NodeInspector.scan]: the content-based check below matches against
     * *all* text/contentDescription reachable from the root node, with no
     * check for whether a node is actually visible on screen - so a stray
     * "private tab"-style label sitting off-screen or in a collapsed panel
     * anywhere in Chrome's tree could match regardless of what's actually
     * showing, and unlike the title check there was no logging to show
     * which keyword/node caused it. Fixed by (1) gating NodeInspector's text
     * collection on `isVisibleToUser()`, so only what's actually on screen
     * can match, and (2) [matchingContentKeyword] surfacing which keyword
     * matched in the exit log, so a recurrence is a direct lookup instead of
     * another guess. Re-enabled here on that basis - if GATE4_INCOGNITO_DETECTED
     * content still fires on ordinary Chrome browsing, the logged keyword is
     * the next lead, not a re-run of the whole investigation.
     */
    val BROWSER_PACKAGES = setOf(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.chrome.canary",
        "org.mozilla.firefox",
        "org.mozilla.firefox_beta",
        "org.mozilla.fenix",
        "com.microsoft.emmx",
        "com.sec.android.app.sbrowser",
        "com.opera.browser",
        "com.opera.mini.native",
        "com.opera.touch",
        "com.brave.browser",
        "com.vivaldi.browser",
        "com.duckduckgo.mobile.android",
        "com.kiwibrowser.browser",
        "com.UCMobile.intl",
        "com.mi.globalbrowser",
        "com.yandex.browser",

        // Added for broader incognito-browser coverage (deliberately not
        // "beyond browsers" into other apps' own private-chat features -
        // those would need their own, unverified keyword sets; see this
        // class's own false-positive history for why that's not a guess
        // worth making without real-device text to confirm). Safe to add
        // liberally: an unmatched package name here is a pure no-op, never
        // a false-positive risk - the worst case for a wrong/unused entry
        // is simply "does nothing," not "breaks something." Most of these
        // are Chromium or Firefox forks that inherit the same upstream
        // "Incognito"/"Private Browsing" UI strings TITLE_KEYWORDS/
        // CONTENT_KEYWORDS already cover, so no new keywords were added
        // alongside these - only the newest few (Naver Whale, Huawei
        // Browser) haven't been directly confirmed on-device; if
        // GATE4_INCOGNITO_DETECTED never fires for one of those, that's
        // the first thing to check via the Debug log rather than assumed
        // broken.
        "org.mozilla.focus", // Firefox Focus - always-private by design, no separate mode to detect
        "org.mozilla.klar", // Firefox Klar (Focus, DE branding)
        "org.torproject.torbrowser", // Tor Browser - Firefox-derived
        "com.cloudmosa.puffin", // Puffin Browser
        "mobi.mgeek.TunnyBrowser", // Dolphin Browser
        "com.naver.whale", // Naver Whale
        "com.huawei.browser", // Huawei Browser
        "com.ghostery.android.ghostery", // Ghostery Privacy Browser
        "org.bromite.bromite", // Bromite (privacy-focused Chromium fork)
        "com.alohamobile.browser", // Aloha Browser
        "com.ecosia.android", // Ecosia - Chromium-based

        // Confirmed via real on-device log (NudeNetDetector reached the
        // classifier for this package with none of the incognito-specific
        // gates having fired first) - not a guess. Always-private by
        // design like Firefox Focus above, so the title/content keyword
        // checks may have little or nothing to match; gate 5b's structural
        // FLAG_SECURE detection is what actually protects this one.
        "com.androidbull.incognito.browser", // Incognito Browser (AndroidBull)
    )

    fun isBrowserPackage(packageName: String): Boolean = packageName in BROWSER_PACKAGES

    // Checked against a single short window/task title string (see
    // ContentGuardService's title-based guard pattern, already used for
    // the Settings/Accessibility screen) - no concatenation risk, so the
    // bare word "incognito" is safe to include here.
    private val TITLE_KEYWORDS = listOf(
        "incognito",
        "private browsing",
        "private tab",
        "private window",
        "inprivate",
        "secret mode",
        "go incognito",
        "browse privately",
        "you've gone incognito",
    )

    // Checked against NodeInspector's whole-tree concatenated text -
    // deliberately excludes the bare word "incognito" (see class doc,
    // point 2) in favor of only the multi-word phrases that appear on a
    // browser's actual "you're private now" landing content, which aren't
    // known to leak from persistent chrome/menu residue the way the bare
    // word did.
    //
    // "go incognito" / "browse privately" added after real-device testing
    // found entering incognito via Google's own account-chooser page (the
    // "Go Incognito" / "Browse privately or sign in temporarily" option
    // under accounts.google.com's account picker, not Chrome's own "New
    // Incognito Tab" menu item) wasn't blocked. That flow opens a real
    // incognito tab, but navigates straight to a page rather than showing
    // the blank "New Incognito tab" placeholder - so TITLE_KEYWORDS' bare
    // "incognito" match never fired, since the resulting title is just
    // whatever page loaded, not a title containing "incognito" at all.
    // "you've gone incognito" is Chrome's own well-known Incognito New Tab
    // Page heading, added on the same reasoning even though it wasn't
    // directly observed missing - covers the case where an incognito tab
    // does land on Chrome's own NTP rather than a specific URL.
    private val CONTENT_KEYWORDS = listOf(
        "private browsing",
        "private tab",
        "private window",
        "inprivate",
        "secret mode",
        "go incognito",
        "browse privately",
        "you've gone incognito",
    )

    fun matchesTitle(text: String): Boolean = containsAny(text, TITLE_KEYWORDS)

    // Returns which keyword matched, not just whether one did - the title
    // check had GATE4_TITLE_DEBUG logging to show exactly what it saw before
    // being trusted; the content check had no equivalent, which is exactly
    // why a real false-positive here (a stray "private tab"-style label
    // somewhere in the tree) was undiagnosable last time instead of being a
    // quick keyword-and-source lookup.
    fun matchingContentKeyword(text: String): String? {
        if (text.isBlank()) return null
        val lower = text.lowercase()
        return CONTENT_KEYWORDS.firstOrNull { lower.contains(it) }
    }

    private fun containsAny(text: String, keywords: List<String>): Boolean {
        if (text.isBlank()) return false
        val lower = text.lowercase()
        return keywords.any { lower.contains(it) }
    }
}
