package com.contentguard.app

import android.app.Application
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.util.CrashLog
import com.contentguard.app.util.DebugLogBuffer

/**
 * Runs first in every process this app starts (Settings UI, the
 * accessibility service, the watchdog service all share one process - none
 * of the manifest's components declare android:process), which is what
 * makes this the one place that can both install [CrashLog]'s handler
 * before anything else gets a chance to crash, and unconditionally surface
 * what happened on the *previous* run before whichever component happens
 * to start first this time gets going.
 *
 * See CrashLog's doc comment for the actual bug this exists to fix: a
 * crash used to leave zero trace anywhere reachable without adb, because
 * DebugLogBuffer is memory-only and dies with the process it was trying to
 * explain.
 */
class ContentGuardApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        CrashLog.drainPersistedCrash(this)
        logRestartGap()
    }

    /**
     * Covers the crash case [CrashLog] structurally can't: the OS/OEM
     * SIGKILLing this process outright (ColorOS's aggressive background
     * management - see docs/COLOROS.md) with no exception ever thrown, so
     * nothing here ever ran to record one. That case is still a "the app
     * stopped working" event from the user's point of view, and previously
     * left exactly as little trace as an actual crash did.
     *
     * lastHeartbeatAtMillis is stamped every few minutes for as long as
     * ContentGuardService is genuinely alive (see its heartbeatLoop) and
     * deliberately never cleared on a clean stop, so a large gap between it
     * and "now, on a fresh process" is itself evidence the previous process
     * ended abruptly rather than idly - the whole basis
     * AccessibilityWatchdogService.checkHeartbeatAndKick already relies on
     * for the same signal. Zero is left alone (fresh install, or
     * accessibility never having been turned on yet) rather than logged as
     * a gap against nothing.
     */
    private fun logRestartGap() {
        val prefs = PrefsRepository(this)
        val lastHeartbeat = prefs.lastHeartbeatAtMillis
        if (lastHeartbeat == 0L) return
        val gapMs = System.currentTimeMillis() - lastHeartbeat
        val gapMinutes = gapMs / 60_000
        DebugLogBuffer.add(TAG, "Process (re)started - last heartbeat was ${gapMinutes}min ago")
    }

    companion object {
        private const val TAG = "ContentGuardApplication"
    }
}
