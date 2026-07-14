package com.contentguard.app.scope

import com.contentguard.app.BuildConfig

/** Gate 1 of the cascade - the only gate cheap enough to run with zero capture. */
class AppScopePolicy(private val prefs: PrefsRepository) {

    fun shouldMonitor(packageName: String): Boolean {
        if (isHardExcluded(packageName)) return false
        return when (prefs.mode) {
            ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST -> packageName !in prefs.getWhitelist()
            ScopeMode.MONITOR_ONLY_LISTED -> packageName in prefs.getMonitoredSet()
        }
    }

    /**
     * Packages that are never monitored and never count as a "real"
     * foreground app switch, regardless of scope mode: our own UI/overlay
     * (BuildConfig.APPLICATION_ID tracks the debug ".debug" suffix too),
     * and system UI chrome (status bar, nav bar, quick settings), which
     * fires window-state events constantly but is never content worth
     * scoring.
     */
    fun isHardExcluded(packageName: String): Boolean =
        packageName == BuildConfig.APPLICATION_ID || packageName == SYSTEM_UI_PACKAGE

    companion object {
        private const val SYSTEM_UI_PACKAGE = "com.android.systemui"
    }
}
