package com.contentguard.app.scope

import android.content.Context
import android.content.SharedPreferences

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

    companion object {
        private const val PREFS_NAME = "content_guard_prefs"
        private const val KEY_MODE = "scope_mode"
        private const val KEY_WHITELIST = "whitelist_packages"
        private const val KEY_MONITORED = "monitored_packages"
        private const val KEY_THRESHOLD = "nsfw_threshold"
        private const val KEY_DISMISS_ON_BLOCK = "dismiss_on_block"
        private const val KEY_SCREENSHOT_COUNT = "stats_screenshot_count"
        private const val KEY_INFERENCE_COUNT = "stats_inference_count"
        private const val KEY_TOTAL_INFERENCE_MS = "stats_total_inference_ms"
        private const val KEY_BLOCK_COUNT = "stats_block_count"
        private const val KEY_STATS_SINCE = "stats_since_millis"
        const val DEFAULT_THRESHOLD = 0.80f
    }
}
