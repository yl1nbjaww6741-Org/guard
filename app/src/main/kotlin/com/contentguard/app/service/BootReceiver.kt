package com.contentguard.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the accessibility watchdog after every reboot - see AccessibilityWatchdogService's doc comment. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            AccessibilityWatchdogService.start(context)
            // A reboot clears every AlarmManager alarm the app had pending,
            // WatchdogAlarmReceiver's included - re-arm it here rather than
            // relying solely on AccessibilityWatchdogService.onCreate doing
            // so, since that only runs once this service actually starts,
            // which the line above triggers but isn't guaranteed to have
            // completed by the time this receiver returns.
            AccessibilityWatchdogService.scheduleWatchdogAlarm(context)
        }
    }
}
