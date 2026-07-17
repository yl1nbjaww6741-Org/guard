package com.contentguard.app.scope

import android.content.Context
import android.content.SharedPreferences
import com.contentguard.app.detect.KeywordBlocklist
import java.security.MessageDigest

/**
 * SharedPreferences on purpose, not DataStore: after the first (async,
 * one-time) XML parse, every read is a synchronous in-memory map lookup,
 * which is what we need on the accessibility-event hot path. DataStore's
 * Flow-based API would force us to cache values ourselves anyway.
 */
class PrefsRepository(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var mode: ScopeMode
        get() {
            val raw = prefs.getString(KEY_MODE, null) ?: return ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST
            return runCatching { ScopeMode.valueOf(raw) }.getOrDefault(ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST)
        }
        set(value) {
            prefs.edit().putString(KEY_MODE, value.name).apply()
        }

    var nsfwThreshold: Float
        get() = prefs.getFloat(KEY_THRESHOLD, DEFAULT_THRESHOLD)
        set(value) {
            prefs.edit().putFloat(KEY_THRESHOLD, value.coerceIn(0f, 1f)).apply()
        }

    var dismissOnBlock: Boolean
        get() = prefs.getBoolean(KEY_DISMISS_ON_BLOCK, false)
        set(value) {
            prefs.edit().putBoolean(KEY_DISMISS_ON_BLOCK, value).apply()
        }

    /**
     * Minimum time between screenshots while a monitored app is open -
     * previously ScreenCapturer's own hardcoded THROTTLE_FLOOR_MS, now
     * user-tunable from Settings since it's a real latency-vs-battery trade
     * (see SETUP.md's "Tuned for detection speed over battery" / "Doubled
     * back up for battery" history) rather than a one-size-fits-all value.
     */
    var captureThrottleMs: Long
        get() = prefs.getLong(KEY_CAPTURE_THROTTLE_MS, DEFAULT_CAPTURE_THROTTLE_MS)
        set(value) {
            prefs.edit().putLong(KEY_CAPTURE_THROTTLE_MS, value.coerceIn(MIN_CAPTURE_THROTTLE_MS, MAX_CAPTURE_THROTTLE_MS)).apply()
        }

    /**
     * Kept in lockstep with [captureThrottleMs] rather than independently
     * configurable - it only ever needs to stay a little above the capture
     * throttle floor (see ContentGuardService.recheckStaticContent's doc
     * comment), or the periodic backstop would just spend ticks getting
     * throttled away for no benefit. A second slider for this specifically
     * would let the user create that exact bad configuration for no gain.
     */
    val staticRecheckIntervalMs: Long
        get() = captureThrottleMs + STATIC_RECHECK_MARGIN_MS

    fun getWhitelist(): Set<String> = prefs.getStringSet(KEY_WHITELIST, null)?.toSet() ?: emptySet()

    fun setWhitelisted(packageName: String, whitelisted: Boolean) {
        val next = getWhitelist().toMutableSet()
        if (whitelisted) next.add(packageName) else next.remove(packageName)
        prefs.edit().putStringSet(KEY_WHITELIST, next).apply()
    }

    fun getMonitoredSet(): Set<String> = prefs.getStringSet(KEY_MONITORED, null)?.toSet() ?: emptySet()

    fun setMonitored(packageName: String, monitored: Boolean) {
        val next = getMonitoredSet().toMutableSet()
        if (monitored) next.add(packageName) else next.remove(packageName)
        prefs.edit().putStringSet(KEY_MONITORED, next).apply()
    }

    /**
     * Gate 4b's active keyword set - starts from [KeywordBlocklist.EXPLICIT_KEYWORDS]
     * (the built-in default) until the user customizes it via Settings, at
     * which point the stored set becomes authoritative rather than layered
     * on top of the default. Editable the same way threshold/lockout/
     * whitelist already are - password-gated Settings, not a dedicated
     * on/off switch (see IncognitoDetector/KeywordBlocklist doc comments
     * for why this feature itself has no such switch).
     */
    fun getExplicitKeywords(): Set<String> =
        prefs.getStringSet(KEY_EXPLICIT_KEYWORDS, null)?.toSet() ?: KeywordBlocklist.EXPLICIT_KEYWORDS

    fun setExplicitKeywords(keywords: Set<String>) {
        val normalized = keywords.map { it.trim().lowercase() }.filter { it.isNotBlank() }.toSet()
        prefs.edit().putStringSet(KEY_EXPLICIT_KEYWORDS, normalized).apply()
    }

    fun addExplicitKeyword(keyword: String) {
        setExplicitKeywords(getExplicitKeywords() + keyword)
    }

    fun removeExplicitKeyword(keyword: String) {
        setExplicitKeywords(getExplicitKeywords() - keyword)
    }

    /** Reverts to the built-in default list by clearing the stored override entirely. */
    fun resetExplicitKeywordsToDefault() {
        prefs.edit().remove(KEY_EXPLICIT_KEYWORDS).apply()
    }

    fun explicitKeywordsAreCustomized(): Boolean = prefs.contains(KEY_EXPLICIT_KEYWORDS)

    /**
     * Not real battery-percentage accounting - Android doesn't expose that
     * to third-party apps, only the OS's own battery stats (Settings >
     * Battery, or `adb shell dumpsys batterystats`) have that. This is a
     * proxy: counts of the two operations that actually cost real battery
     * (screenshot capture, classifier inference), so relative load is
     * visible without pretending to be a number this app can't actually
     * measure. See SettingsActivity's "Activity since last reset" card.
     */
    data class UsageStats(
        val screenshotCount: Int,
        val inferenceCount: Int,
        val totalInferenceMs: Long,
        val blockCount: Int,
        val sinceMillis: Long,
    ) {
        val avgInferenceMs: Double get() = if (inferenceCount == 0) 0.0 else totalInferenceMs.toDouble() / inferenceCount
    }

    fun getUsageStats(): UsageStats = UsageStats(
        screenshotCount = prefs.getInt(KEY_SCREENSHOT_COUNT, 0),
        inferenceCount = prefs.getInt(KEY_INFERENCE_COUNT, 0),
        totalInferenceMs = prefs.getLong(KEY_TOTAL_INFERENCE_MS, 0L),
        blockCount = prefs.getInt(KEY_BLOCK_COUNT, 0),
        sinceMillis = prefs.getLong(KEY_STATS_SINCE, 0L),
    )

    fun recordScreenshot() {
        prefs.edit().putInt(KEY_SCREENSHOT_COUNT, prefs.getInt(KEY_SCREENSHOT_COUNT, 0) + 1).apply()
    }

    fun recordInference(latencyMs: Long) {
        prefs.edit()
            .putInt(KEY_INFERENCE_COUNT, prefs.getInt(KEY_INFERENCE_COUNT, 0) + 1)
            .putLong(KEY_TOTAL_INFERENCE_MS, prefs.getLong(KEY_TOTAL_INFERENCE_MS, 0L) + latencyMs)
            .apply()
    }

    fun recordBlock() {
        prefs.edit().putInt(KEY_BLOCK_COUNT, prefs.getInt(KEY_BLOCK_COUNT, 0) + 1).apply()
    }

    fun resetUsageStats() {
        prefs.edit()
            .putInt(KEY_SCREENSHOT_COUNT, 0)
            .putInt(KEY_INFERENCE_COUNT, 0)
            .putLong(KEY_TOTAL_INFERENCE_MS, 0L)
            .putInt(KEY_BLOCK_COUNT, 0)
            .putLong(KEY_STATS_SINCE, System.currentTimeMillis())
            .apply()
    }

    var lockoutDurationMinutes: Int
        get() = prefs.getInt(KEY_LOCKOUT_DURATION_MIN, DEFAULT_LOCKOUT_MINUTES)
        set(value) {
            prefs.edit().putInt(KEY_LOCKOUT_DURATION_MIN, value.coerceIn(1, 60)).apply()
        }

    // Adjustable so testing doesn't keep tripping a real lockout after a
    // couple of blocks - raise it for a longer test session, not a
    // permanent behavior change.
    var strikesToLockout: Int
        get() = prefs.getInt(KEY_STRIKES_TO_LOCKOUT, DEFAULT_STRIKES_TO_LOCKOUT)
        set(value) {
            prefs.edit().putInt(KEY_STRIKES_TO_LOCKOUT, value.coerceIn(1, 20)).apply()
        }

    /**
     * Records an explicit-content detection for [packageName] and, once
     * [strikesToLockout] such strikes land within a rolling 15-minute
     * window, locks that single app out for [lockoutDurationMinutes].
     * Returns true exactly when this call was the one that triggered the
     * lockout, so the caller can log it distinctly from an ordinary strike.
     */
    fun recordExplicitStrike(packageName: String): Boolean {
        val now = System.currentTimeMillis()
        val key = strikeKey(packageName)
        val recentStrikes = (prefs.getStringSet(key, null) ?: emptySet())
            .mapNotNull { it.toLongOrNull() }
            .filter { now - it < STRIKE_WINDOW_MS }
            .toMutableList()
        recentStrikes.add(now)

        if (recentStrikes.size >= strikesToLockout) {
            prefs.edit()
                .remove(key)
                .putLong(lockoutKey(packageName), now + lockoutDurationMinutes * 60_000L)
                .apply()
            return true
        }
        prefs.edit().putStringSet(key, recentStrikes.map { it.toString() }.toSet()).apply()
        return false
    }

    fun isLockedOut(packageName: String): Boolean = getLockoutUntil(packageName) > System.currentTimeMillis()

    fun getLockoutUntil(packageName: String): Long = prefs.getLong(lockoutKey(packageName), 0L)

    /** Package name -> lockout-expiry millis, for currently locked-out apps only. Debug/Settings display use. */
    fun getActiveLockouts(): Map<String, Long> {
        val now = System.currentTimeMillis()
        return prefs.all
            .mapNotNull { (key, value) ->
                if (!key.startsWith(KEY_LOCKOUT_PREFIX) || value !is Long) return@mapNotNull null
                if (value <= now) return@mapNotNull null
                key.removePrefix(KEY_LOCKOUT_PREFIX) to value
            }
            .toMap()
    }

    private fun strikeKey(packageName: String) = "$KEY_STRIKES_PREFIX$packageName"
    private fun lockoutKey(packageName: String) = "$KEY_LOCKOUT_PREFIX$packageName"

    /**
     * Gates ContentGuard's own Settings screen and (see ContentGuardService)
     * the system "Device admin apps" screen - without the latter, deactivating
     * device admin would undo the force-stop/uninstall protection with zero
     * friction. Stored as a salted SHA-256 hash, never the raw password.
     */
    fun hasPassword(): Boolean = prefs.contains(KEY_PASSWORD_HASH)

    fun setPassword(raw: String) {
        prefs.edit().putString(KEY_PASSWORD_HASH, hash(raw)).apply()
    }

    fun verifyPassword(raw: String): Boolean {
        val stored = prefs.getString(KEY_PASSWORD_HASH, null) ?: return false
        return stored == hash(raw)
    }

    private fun hash(raw: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest((PASSWORD_SALT + raw).toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val PREFS_NAME = "content_guard_prefs"
        private const val KEY_MODE = "scope_mode"
        private const val KEY_WHITELIST = "whitelist_packages"
        private const val KEY_EXPLICIT_KEYWORDS = "explicit_keywords"
        private const val KEY_MONITORED = "monitored_packages"
        private const val KEY_THRESHOLD = "nsfw_threshold"
        private const val KEY_DISMISS_ON_BLOCK = "dismiss_on_block"
        private const val KEY_SCREENSHOT_COUNT = "stats_screenshot_count"
        private const val KEY_INFERENCE_COUNT = "stats_inference_count"
        private const val KEY_TOTAL_INFERENCE_MS = "stats_total_inference_ms"
        private const val KEY_BLOCK_COUNT = "stats_block_count"
        private const val KEY_STATS_SINCE = "stats_since_millis"
        private const val KEY_LOCKOUT_DURATION_MIN = "lockout_duration_min"
        private const val KEY_STRIKES_TO_LOCKOUT = "strikes_to_lockout"
        private const val KEY_STRIKES_PREFIX = "strike_times_"
        private const val KEY_LOCKOUT_PREFIX = "lockout_until_"
        private const val KEY_PASSWORD_HASH = "password_hash"
        private const val KEY_CAPTURE_THROTTLE_MS = "capture_throttle_ms"
        private const val PASSWORD_SALT = "contentguard-v1-"
        const val DEFAULT_THRESHOLD = 0.80f
        const val DEFAULT_LOCKOUT_MINUTES = 1
        const val DEFAULT_STRIKES_TO_LOCKOUT = 3
        private const val STRIKE_WINDOW_MS = 15 * 60 * 1000L

        // 1800ms default matches ScreenCapturer's old hardcoded value - see
        // SETUP.md's capture-cadence history for how that number was
        // reached. Floor of 900ms because going lower buys nothing: that's
        // roughly the platform's own takeScreenshot() rate limit
        // (ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT), so the OS starts
        // rejecting calls before a lower slider value would even matter.
        const val DEFAULT_CAPTURE_THROTTLE_MS = 1800L
        const val MIN_CAPTURE_THROTTLE_MS = 900L
        const val MAX_CAPTURE_THROTTLE_MS = 5000L

        // Not private - SettingsActivity's capture-cadence card references
        // this directly so its description text can't drift from the
        // actual margin staticRecheckIntervalMs applies.
        const val STATIC_RECHECK_MARGIN_MS = 200L
    }
}
