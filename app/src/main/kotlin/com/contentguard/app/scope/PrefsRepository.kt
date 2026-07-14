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

    companion object {
        private const val PREFS_NAME = "content_guard_prefs"
        private const val KEY_MODE = "scope_mode"
        private const val KEY_WHITELIST = "whitelist_packages"
        private const val KEY_MONITORED = "monitored_packages"
        private const val KEY_THRESHOLD = "nsfw_threshold"
        private const val KEY_DISMISS_ON_BLOCK = "dismiss_on_block"
        const val DEFAULT_THRESHOLD = 0.80f
    }
}
