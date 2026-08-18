package com.contentguard.app.util

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Answers the actual bug report this exists to fix: "the app stops working
 * every couple of days and the log isn't even logging". [DebugLogBuffer] is
 * documented as in-memory only, cleared whenever the process dies - which
 * is precisely when a user goes looking for it, since a fresh process is
 * the *only* time the Debug log card is reachable at all. Whatever explains
 * a crash was written to a buffer that no longer exists by the time anyone
 * can read it. Nothing before this ever persisted a crash reason anywhere
 * - no Thread.UncaughtExceptionHandler, no crash file, nothing outside
 * logcat (which requires adb, and rotates out within minutes anyway - see
 * SETUP.md's whole point of avoiding needing adb for day-to-day use).
 *
 * [install] hooks Thread.setDefaultUncaughtExceptionHandler and, for a real
 * uncaught exception, synchronously writes it to a small file in
 * [Context.getFilesDir] before chaining to whatever handler was previously
 * installed (so the OS still sees the crash and does its normal thing -
 * this only adds a durable record, never suppresses the crash itself).
 * Synchronous and file-based rather than routed through DebugLogBuffer or
 * SharedPreferences: the process is moments from dying, so this can't rely
 * on a background thread getting scheduled, and SharedPreferences.edit()
 * is itself an async-by-default XML rewrite that isn't guaranteed to land
 * before the process is gone.
 *
 * [drainPersistedCrash] is the other half: called once from
 * ContentGuardApplication.onCreate on every fresh process, it reads
 * whatever [install] left behind (if anything), feeds it into
 * DebugLogBuffer so it's visible in the Activity tab's Debug log card with
 * no adb needed, and deletes the file so the same crash isn't re-reported
 * on every subsequent launch.
 *
 * This only covers crashes that throw - an uncaught exception on some
 * thread. It does not and cannot cover the process being SIGKILLed outright
 * by the OS/OEM (ColorOS's aggressive background management - see
 * docs/COLOROS.md) with no exception ever thrown; nothing running in that
 * process gets a chance to run at that point. See
 * ContentGuardApplication.onCreate's heartbeat-gap log line for how *that*
 * case gets surfaced instead.
 */
object CrashLog {

    private const val FILE_NAME = "crash_log.txt"
    private const val TAG = "CrashLog"

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                persist(appContext, thread, throwable)
            } catch (t: Throwable) {
                // Deliberately swallowed - we're already in the middle of
                // crashing and must not throw a second exception out of the
                // handler itself, which would just replace this crash's
                // real cause with a confusing "failed while logging" one.
                Log.e(TAG, "failed to persist crash log", t)
            }
            previousHandler?.uncaughtException(thread, throwable)
        }
    }

    private fun persist(context: Context, thread: Thread, throwable: Throwable) {
        // Built here rather than held as a shared field: SimpleDateFormat is
        // not thread-safe, and two threads crashing at once is precisely the
        // chaotic case this handler has to stay reliable in. Allocating one
        // per crash costs nothing at most-once-per-process-death.
        val timestampFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
        val report = buildString {
            append(timestampFormat.format(Date()))
            append(" FATAL EXCEPTION (")
            append(thread.name)
            append(")\n")
            append(Log.getStackTraceString(throwable))
        }
        // Overwrite, not append: this is a single "last known crash"
        // record, not a growing history - an unbounded file would be its
        // own slow-motion version of the exact problem this is fixing.
        File(context.filesDir, FILE_NAME).writeText(report)
    }

    /**
     * Reads and clears any crash [install] left behind, mirroring it into
     * [DebugLogBuffer] under this class's own tag. Safe to call every app
     * start - a no-op once there's nothing pending.
     */
    fun drainPersistedCrash(context: Context) {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.exists()) return
        val report = runCatching { file.readText() }.getOrNull()
        file.delete()
        if (report.isNullOrBlank()) return
        DebugLogBuffer.add(TAG, "Previous run crashed - $report")
    }
}
