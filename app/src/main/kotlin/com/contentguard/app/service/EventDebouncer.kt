package com.contentguard.app.service

import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

/**
 * Gate 2 of the cascade. Pure bookkeeping - no capture, no node walk.
 * settleWindowMs lowered from 250ms per explicit "make detection as fast
 * as possible" request - a real battery-for-latency trade (more frames
 * queued during fast scrolling), not a free change.
 */
class EventDebouncer(private val settleWindowMs: Long = 100L) {

    private var lastPackage: String? = null
    private var lastProcessedAt: Long = 0L

    /** Returns true if this event should proceed to the next gate. */
    fun shouldProcess(event: AccessibilityEvent): Boolean {
        val packageName = event.packageName?.toString()
        val now = SystemClock.elapsedRealtime()

        val isAppSwitch = event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            packageName != lastPackage

        if (isAppSwitch) {
            lastPackage = packageName
            lastProcessedAt = now
            return true
        }

        if (now - lastProcessedAt < settleWindowMs) {
            return false
        }

        lastProcessedAt = now
        return true
    }
}
