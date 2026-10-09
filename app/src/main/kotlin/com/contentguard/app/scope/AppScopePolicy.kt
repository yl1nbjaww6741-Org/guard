package com.contentguard.app.scope

import android.content.Intent
import android.content.pm.PackageManager
import com.contentguard.app.BuildConfig

/** Gate 1 of the cascade - the only gate cheap enough to run with zero capture. */
class AppScopePolicy(private val prefs: PrefsRepository) {

    fun shouldMonitor(packageName: String): Boolean = decide(
        packageName = packageName,
        mode = prefs.mode,
        whitelist = prefs.getWhitelist(),
        monitorOverrides = prefs.getMonitorOverrides(),
        monitoredSet = prefs.getMonitoredSet(),
    )

    /**
     * Packages that are never monitored and never count as a "real"
     * foreground app switch, regardless of scope mode: our own UI/overlay
     * (BuildConfig.APPLICATION_ID tracks the debug ".debug" suffix too),
     * and system UI chrome (status bar, nav bar, quick settings), which
     * fires window-state events constantly but is never content worth
     * scoring.
     *
     * Launchers are deliberately NOT in this set even though they're
     * excluded by default too (see [decide]): this set feeds
     * isRealAppSwitch in ContentGuardService, and going home *is* a real
     * app switch - it's what hides a standing block overlay. Hard-excluding
     * the launcher here would leave the overlay stuck on screen after a
     * Home press.
     */
    fun isHardExcluded(packageName: String): Boolean = Companion.isHardExcluded(packageName)

    companion object {
        private const val SYSTEM_UI_PACKAGE = "com.android.systemui"

        fun isHardExcluded(packageName: String): Boolean =
            packageName == BuildConfig.APPLICATION_ID || packageName == SYSTEM_UI_PACKAGE

        /**
         * The one implementation of "is this package in scope", shared by
         * gate 1 and by the Apps tab's toggles.
         *
         * The Apps tab used to answer this itself with its own
         * `pkg !in whitelist` shorthand, which quietly stopped matching what
         * the service actually does once the launcher carve-out below
         * landed: the toggle read "monitored" for a HOME-handler package
         * that gate 1 was still dropping at GATE1_WHITELIST, so
         * un-whitelisting such an app looked like it worked and never
         * started a capture. Both callers go through here now so the panel
         * can only ever show the answer the cascade will actually give.
         */
        fun decide(
            packageName: String,
            mode: ScopeMode,
            whitelist: Set<String>,
            monitorOverrides: Set<String>,
            monitoredSet: Set<String>,
        ): Boolean {
            if (isHardExcluded(packageName)) return false
            return when (mode) {
                // Launchers are treated as implicitly whitelisted here: a
                // home screen is wallpaper + icon grid, never content worth
                // scoring, but under this mode it counted as monitored
                // (it's not in the user's whitelist), so dwelling on the
                // home screen ran the whole cascade - screenshot, skin
                // prefilter, and (for any wallpaper with skin-range colours,
                // i.e. most photos of people) a full classifier inference -
                // every static-recheck tick, indefinitely, in the single
                // most common screen-on state there is.
                //
                // It's a *default*, not a veto: an explicit "monitor this
                // app" from the Apps tab (recorded in monitorOverrides -
                // see PrefsRepository.getMonitorOverrides) wins, the same
                // way an explicit entry does under MONITOR_ONLY_LISTED.
                // Some devices ship apps the user genuinely wants watched
                // that also register a HOME activity - TV/set-top and car
                // launchers especially - and before the override those were
                // simply unmonitorable, with a toggle that said otherwise.
                ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST ->
                    packageName !in whitelist &&
                        (packageName !in launcherPackages || packageName in monitorOverrides)
                // Deliberately no launcher carve-out in this mode: a package
                // is only monitored if the user explicitly listed it, and an
                // explicit choice to monitor the launcher stays respected.
                ScopeMode.MONITOR_ONLY_LISTED -> packageName in monitoredSet
            }
        }

        /** Whether [packageName] is one of the HOME handlers [decide] excludes by default. */
        fun isLauncher(packageName: String): Boolean = packageName in launcherPackages

        // Same pattern as IncognitoDetector's dynamic browser set: queried
        // from the platform's own record of which apps register as a HOME
        // handler (the launcher itself lives under CATEGORY_HOME, not
        // CATEGORY_LAUNCHER - see AndroidManifest.xml's <queries> comment),
        // refreshed by ContentGuardService on (re)connect and on package
        // install/update rather than polled, and by the Apps tab when it
        // builds its list (the settings UI can be opened before the service
        // has ever connected, and it needs the same set to show the same
        // answer). Process-wide so every refresh is visible to every
        // AppScopePolicy instance.
        @Volatile
        private var launcherPackages: Set<String> = emptySet()

        fun refreshInstalledLaunchers(packageManager: PackageManager) {
            // Flags 0 (not MATCH_DEFAULT_ONLY), matching AppsTab's own
            // launcher detection - a HOME activity missing CATEGORY_DEFAULT
            // should still be excluded here.
            val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            @Suppress("DEPRECATION")
            val resolved = packageManager.queryIntentActivities(homeIntent, 0)
            launcherPackages = resolved.map { it.activityInfo.packageName }.toSet()
        }
    }
}
