package com.contentguard.app.detect

/**
 * Gate 4 of the cascade, actually implemented: browser-agnostic detection
 * of private/incognito browsing. Keyed on UI text rather than a fixed list
 * of browser packages, so it isn't limited to whichever browsers were
 * tested - every major browser's private mode surfaces one of these words
 * somewhere in its own UI (a landing page like Chrome's "You've gone
 * incognito", a tab-switcher label, an icon's content description), so
 * this generalizes to browsers we haven't specifically checked too.
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
 * Deliberately no Settings toggle to disable this - the whole point is
 * that private/incognito mode can't be used to evade the rest of the
 * cascade, so it can't have an easy in-app off switch any more than the
 * password-gated Settings/Accessibility screens do.
 */
object IncognitoDetector {

    // Deliberately compound phrases, not bare words like "private" - that
    // one alone collides with normal app text (private messages, private
    // groups, etc.) far too often to be a safe signal on its own.
    private val KEYWORDS = listOf(
        "incognito", // Chrome, Brave, Kiwi, UC Browser, most Chromium-based browsers
        "private browsing", // Firefox
        "private tab", // Firefox, Opera, Brave ("new private tab")
        "private window", // Vivaldi
        "inprivate", // Edge ("InPrivate")
        "secret mode", // Samsung Internet
    )

    fun matches(text: String): Boolean {
        if (text.isBlank()) return false
        val lower = text.lowercase()
        return KEYWORDS.any { lower.contains(it) }
    }
}
