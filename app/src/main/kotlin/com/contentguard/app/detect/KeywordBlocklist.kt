package com.contentguard.app.detect

/**
 * Gate 4b of the cascade: blocks on explicit content *rendered on screen*,
 * not just what's typed - matching known adult-content keywords against
 * [NodeScanResult.visibleText] (every visible node's text/contentDescription,
 * concatenated), so a page/post/feed showing one of these terms gets
 * blocked whether it was reached by typing a search, tapping a link or
 * thumbnail, or just scrolling into it.
 *
 * This is a deliberate, explicit trade of precision for coverage. An
 * earlier version of this gate matched only [NodeScanResult]'s editable-
 * field text (what's actively being typed) specifically *because* whole-
 * page text matching is false-positive-prone: health/biology articles,
 * sex-ed material, ordinary news coverage, and moderation-policy
 * discussions can all legitimately contain these words, and gate 4 (see
 * [IncognitoDetector]) already hit exactly this failure mode once with a
 * much narrower keyword list (Chrome got fully blocked on ordinary
 * browsing before its root cause was found - see SETUP.md). Switched to
 * whole-page matching anyway, on the reasoning that catching content
 * someone tapped or scrolled to (never typed) matters more than the
 * narrower gate's precision - so a real false positive here is an
 * accepted possibility, not a bug. [ContentGuardService] logs
 * `GATE4B_KEYWORD_BLOCKED keyword="..."` on every block specifically so a
 * false positive is a direct lookup instead of a re-investigation, the
 * same diagnose-from-logs pattern gate 4 already established.
 *
 * [EXPLICIT_KEYWORDS] favors high-precision terms - known adult platform
 * names and explicit-content genre words - over bare anatomical terms,
 * which appear constantly in ordinary, non-adult contexts and would be
 * far noisier still against whole-page text. Not exhaustive by design: a
 * starting set of the terms most likely to indicate adult content, not an
 * attempt to enumerate every possible adult site or slang term that
 * exists - see [PrefsRepository.getExplicitKeywords] for the editable,
 * persisted set actually used at runtime (this constant is only its
 * default until customized).
 *
 * No dedicated on/off Settings toggle, same reasoning as IncognitoDetector -
 * but unlike that gate, the keyword *content* itself is deliberately
 * editable through the same password-gated Settings screen threshold/
 * lockout/whitelist already use, not hardcoded. That's a real, accepted
 * trade-off: clearing every keyword does functionally disable this gate,
 * same as setting the NSFW threshold to 1.0 already can for gates 6/7 -
 * kept editable anyway because a fixed, unreviewable list can't be tuned
 * for false positives/negatives the developer actually observes. Given
 * the false-positive risk above, that editability matters more here than
 * it did for the narrower input-field version - removing a keyword that
 * turns out to be too broad (e.g. a term that also names a mainstream
 * news topic) is the intended escape hatch, not just a nice-to-have.
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

        // Magnet links/.torrent files - a common way explicit content gets
        // downloaded rather than streamed. High-precision the same way the
        // platform names above are: neither string has an ordinary,
        // non-file-sharing meaning that would show up in typed text.
        "magnet:", ".torrent",
    )

    /** [keywords] defaults to the built-in list; callers pass PrefsRepository's stored set instead when available. */
    fun matchingKeyword(text: String, keywords: Set<String> = EXPLICIT_KEYWORDS): String? {
        if (text.isBlank()) return null
        val lower = text.lowercase()
        return keywords.firstOrNull { lower.contains(it) }
    }
}
