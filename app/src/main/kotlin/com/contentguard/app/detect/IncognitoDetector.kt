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
 *    concatenation risk) for exactly this reason - see [matchesContent].
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
     * Chrome's own package IDs are deliberately OUT of this set for now -
     * real-device testing kept reporting Chrome fully blocked even after
     * the title check was confirmed correct in isolation
     * (GATE4_TITLE_DEBUG showed "Chrome: New tab" not matching and "Chrome:
     * New Incognito tab" matching, exactly as intended), so something else
     * about Chrome specifically is still misfiring that hasn't been root-
     * caused yet. Pulled out entirely rather than half-fixed so normal
     * Chrome use isn't broken while this gets revisited - re-add
     * "com.android.chrome" (and the channel variants below) once the real
     * cause is found.
     */
    val BROWSER_PACKAGES = setOf(
        // "com.android.chrome",
        // "com.chrome.beta",
        // "com.chrome.dev",
        // "com.chrome.canary",
        "org.mozilla.firefox",
        "org.mozilla.firefox_beta",
        "org.mozilla.fenix",
        "com.microsoft.emmx",
        "com.sec.android.app.sbrowser",
        "com.opera.browser",
        "com.opera.mini.native",
        "com.brave.browser",
        "com.vivaldi.browser",
        "com.duckduckgo.mobile.android",
        "com.kiwibrowser.browser",
        "com.UCMobile.intl",
        "com.mi.globalbrowser",
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
    )

    // Checked against NodeInspector's whole-tree concatenated text -
    // deliberately excludes the bare word "incognito" (see class doc,
    // point 2) in favor of only the multi-word phrases that appear on a
    // browser's actual "you're private now" landing content, which aren't
    // known to leak from persistent chrome/menu residue the way the bare
    // word did.
    private val CONTENT_KEYWORDS = listOf(
        "private browsing",
        "private tab",
        "private window",
        "inprivate",
        "secret mode",
    )

    fun matchesTitle(text: String): Boolean = containsAny(text, TITLE_KEYWORDS)

    fun matchesContent(text: String): Boolean = containsAny(text, CONTENT_KEYWORDS)

    private fun containsAny(text: String, keywords: List<String>): Boolean {
        if (text.isBlank()) return false
        val lower = text.lowercase()
        return keywords.any { lower.contains(it) }
    }
}
