package com.contentguard.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the accessibility watchdog after every reboot - see AccessibilityWatchdogService's doc comment. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            AccessibilityWatchdogService.start(context)
        }
    }
}
