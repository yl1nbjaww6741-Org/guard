package com.contentguard.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Backstop for AccessibilityWatchdogService's own process being killed
 * outright (an OOM/background kill, not a user-initiated Force Stop) - see
 * that service's doc comment for why nothing running inside a dead process
 * can self-heal on its own. AlarmManager is the one mechanism here that
 * survives that kill: the alarm is tracked by the OS, not this app's
 * process, and delivering it - even to a manifest-registered receiver with
 * nothing else currently running - is itself enough for Android to start a
 * fresh process just to run [onReceive]. That's exactly the kick
 * [AccessibilityWatchdogService.start] needs, and that call is deliberately
 * idempotent, so firing this while the watchdog is already alive and
 * healthy is a harmless no-op.
 *
 * Scheduled defensively in two places, same reasoning as
 * AccessibilityWatchdogService.start's own defensive calls elsewhere in the
 * app: [AccessibilityWatchdogService.onCreate] (covers this feature
 * shipping with no reboot in between) and [BootReceiver] (covers the alarm
 * having been cleared by the very reboot that fixes the underlying problem
 * once, so the next occurrence is still covered without a second manual
 * reboot).
 *
 * Not a substitute for a genuine user-initiated Force Stop being honored -
 * Android cancels all of an app's pending alarms on that action specifically,
 * by design, and this receiver has no way around that (nor should it).
 */
class WatchdogAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AccessibilityWatchdogService.start(context)
    }
}
