package com.contentguard.app.detect

/**
 * Pacing and short-term memory for gate 5b's window-security probe
 * (ScreenCapturer.probeWindowSecure) - the state that keeps a definitive
 * platform check from becoming a per-frame cost.
 *
 * Why any state is needed at all: the probe is authoritative but not free.
 * For a *non*-secure window the platform actually renders and hands back a
 * full-window screenshot (which we immediately throw away), so probing on
 * every frame would roughly double this app's capture cost for no new
 * information - a window's FLAG_SECURE state changes when the user opens a
 * private tab or a "hidden" screen, not many times a second. So a verdict is
 * cached per (package, window) and re-checked on the intervals below.
 *
 * The asymmetry in those intervals is the whole design:
 *
 * - A cached verdict is only ever *acted on* while it's still inside its own
 *   re-probe interval, so [shouldProbe] returning false is itself the
 *   statement "the cached verdict is fresh enough to trust" - there's no
 *   separate staleness rule to keep in sync with it.
 * - NOT_SECURE is the verdict that can go stale in the dangerous direction (an
 *   app raising FLAG_SECURE while we're already looking at it - a secret chat
 *   opened, a private tab switched to), so [markSuspiciousFrame] shortens its
 *   next re-probe from [NOT_SECURE_REPROBE_MS] to [REPROBE_MS] as soon as the
 *   pixel heuristic sees a flat-black frame. That's the fast path back to a
 *   definitive answer without paying for it every cycle.
 * - SECURE is re-probed on the short interval too, so a window that *stops*
 *   being secure stops being blocked promptly rather than staying blocked for
 *   as long as a generous cache would hold.
 *
 * [markSuspiciousFrame]'s consecutive-frame count exists only for devices and
 * situations where no definitive answer is available (API < 34, or a probe that
 * came back UNKNOWN). There, gate 5b is back to judging by pixels alone, and a
 * single black frame is genuinely ambiguous - an app-transition frame, a
 * splash screen, and a pure-black dark-mode page all produce one. Requiring
 * two in a row (one capture interval apart) is what separates those from
 * someone actually sitting on a screen we can't see.
 *
 * Not thread-safe by design and doesn't need to be: every method is called
 * from ContentGuardService.processFrame, which runs on the single
 * consumeFrames consumer coroutine. Nothing here is touched from the
 * accessibility-event thread (the (package, window) key makes an explicit
 * app-switch reset unnecessary - a new app or a new window simply misses the
 * cache).
 */
class SecureWindowTracker {

    enum class Verdict { SECURE, NOT_SECURE, UNKNOWN }

    private var cachedPackage: String? = null
    private var cachedWindowId = NO_WINDOW
    private var cachedVerdict: Verdict? = null
    private var cachedAtMs = 0L
    private var suspicionSinceProbe = false

    private var suspiciousPackage: String? = null
    private var suspiciousFrames = 0

    /**
     * True when [windowId] needs a fresh probe. False means [verdictFor]
     * already holds an answer recent enough to act on - see the class doc.
     */
    fun shouldProbe(packageName: String, windowId: Int, nowMs: Long): Boolean {
        if (packageName != cachedPackage || windowId != cachedWindowId) return true
        val verdict = cachedVerdict ?: return true
        val age = nowMs - cachedAtMs
        return when (verdict) {
            Verdict.SECURE, Verdict.UNKNOWN -> age >= REPROBE_MS
            Verdict.NOT_SECURE -> age >= if (suspicionSinceProbe) REPROBE_MS else NOT_SECURE_REPROBE_MS
        }
    }

    fun recordProbe(packageName: String, windowId: Int, verdict: Verdict, nowMs: Long) {
        cachedPackage = packageName
        cachedWindowId = windowId
        cachedVerdict = verdict
        cachedAtMs = nowMs
        suspicionSinceProbe = false
        // A definitive "this window is capturable" retires whatever run of
        // black frames led up to it: those frames were something else (a pure
        // black theme, a transition, a splash), so they must not be left
        // sitting in the counter to be spent later. Without this, a long run of
        // genuinely-black frames on an API 34+ device - which never blocks
        // while the platform keeps answering - would block the instant one
        // probe came back UNKNOWN and dropped the decision to pixels.
        if (verdict == Verdict.NOT_SECURE) {
            markCleanFrame(packageName)
        }
    }

    /**
     * The cached verdict for this window, or null if there isn't one for this
     * (package, window) at all. Only meaningful when [shouldProbe] just
     * returned false - that's what establishes it as still current.
     */
    fun verdictFor(packageName: String, windowId: Int): Verdict? =
        if (packageName == cachedPackage && windowId == cachedWindowId) cachedVerdict else null

    /**
     * Records one flat-black frame (SecureContentDetector's verdict) for
     * [packageName] and returns how many have now arrived in a row. Also marks
     * the cached NOT_SECURE verdict for re-probing on the short interval - see
     * the class doc.
     */
    fun markSuspiciousFrame(packageName: String): Int {
        suspicionSinceProbe = true
        if (packageName != suspiciousPackage) {
            suspiciousPackage = packageName
            suspiciousFrames = 0
        }
        suspiciousFrames++
        return suspiciousFrames
    }

    /** Records a frame that wasn't flat black, breaking any run of suspicious ones. */
    fun markCleanFrame(packageName: String) {
        if (packageName == suspiciousPackage) {
            suspiciousFrames = 0
        }
    }

    companion object {
        private const val NO_WINDOW = -1

        /**
         * Re-probe interval for every verdict except an unsuspicious
         * NOT_SECURE. Comfortably above the platform's own per-window 333ms
         * limit (AccessibilityService.ACCESSIBILITY_TAKE_SCREENSHOT_REQUEST_INTERVAL_TIMES_MS),
         * so pacing here is what spaces probes out rather than collecting
         * ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT and calling it UNKNOWN.
         */
        const val REPROBE_MS = 3_000L

        /**
         * A window that came back capturable, with nothing since to suggest
         * otherwise, is re-checked on this much longer interval - this is the
         * common case (every ordinary screen in every monitored app), so it's
         * what keeps the probe's cost negligible. A FLAG_SECURE raised mid-
         * window doesn't have to wait this out: the first black frame drops it
         * back to [REPROBE_MS] via [markSuspiciousFrame].
         */
        const val NOT_SECURE_REPROBE_MS = 10_000L

        /**
         * Consecutive flat-black frames required to block when no definitive
         * verdict is available (API < 34, or an UNKNOWN probe). See the class
         * doc for why one frame isn't enough on its own.
         */
        const val MIN_UNCONFIRMED_SUSPICIOUS_FRAMES = 2
    }
}
