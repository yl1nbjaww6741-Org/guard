package com.contentguard.app.detect

/**
 * Gate 4b of the cascade: blocks on explicit *search intent* rather than
 * rendered content - matching known adult-content keywords against
 * [NodeScanResult.inputFieldText] (what's actually typed into an address
 * bar or search box), so a query gets blocked before any page or image
 * ever has a chance to load, the same way [IncognitoDetector] blocks a
 * private tab before capture ever runs.
 *
 * Deliberately does *not* match against the whole page's visible text the
 * way [IncognitoDetector]'s content check does. That would catch far more
 * than intended: health/biology articles, sex-ed material, and ordinary
 * news coverage all legitimately contain many of these words, and gate 4
 * already hit exactly this failure mode once (see SETUP.md - Chrome got
 * fully blocked on ordinary browsing before its root cause was found).
 * Restricting matches to editable input fields keeps this to what someone
 * is actively searching for, not incidental page content.
 *
 * The keyword list favors high-precision terms - known adult platform
 * names and explicit-content genre words - over bare anatomical terms,
 * which appear constantly in ordinary, non-adult contexts and would make
 * even the narrower input-field scope noisy. Not exhaustive by design:
 * this is a fixed starting set of the terms someone would actually type to
 * search for adult content, not an attempt to enumerate every possible
 * adult site or slang term that exists.
 *
 * Deliberately no Settings toggle, same reasoning as IncognitoDetector.
 */
object KeywordBlocklist {

    val EXPLICIT_KEYWORDS = setOf(
        // Generic terms/genres
        "porn", "porno", "pornography", "xxx video", "xxx movie",
        "hardcore porn", "softcore porn", "hentai", "erotica",
        "erotic story", "erotic video", "nude pics", "nude photos",
        "naked pics", "naked photos", "sex video", "sex tape",
        "sex chat", "cam girl", "camgirl", "webcam sex", "live sex",
        "adult video", "adult film", "adult content", "fetish porn",
        "milf porn", "escort service", "nsfw video", "onlyfans leak",

        // Well-known adult platforms - high-precision by name, not
        // ambiguous with any non-adult usage
        "pornhub", "xvideos", "xnxx", "xhamster", "redtube", "youporn",
        "brazzers", "spankbang", "onlyfans", "chaturbate", "livejasmin",
        "stripchat", "bongacams", "myfreecams",
    )

    fun matchingKeyword(text: String): String? {
        if (text.isBlank()) return null
        val lower = text.lowercase()
        return EXPLICIT_KEYWORDS.firstOrNull { lower.contains(it) }
    }
}
