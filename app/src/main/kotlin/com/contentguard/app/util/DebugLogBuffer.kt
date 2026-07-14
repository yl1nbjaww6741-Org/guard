package com.contentguard.app.util

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * In-memory ring buffer mirroring the cascade's own Log.d/Log.i calls, so
 * gate exits and classifier scores are viewable from the Settings screen's
 * "Debug log" card without adb. In-memory only - cleared if the process
 * dies, which is an acceptable tradeoff for a diagnostic view, not
 * something requiring durability guarantees.
 */
object DebugLogBuffer {

    private const val MAX_ENTRIES = 400
    private val entries = ArrayDeque<String>()
    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    @Synchronized
    fun add(tag: String, message: String) {
        entries.addLast("${timeFormat.format(Date())} [$tag] $message")
        if (entries.size > MAX_ENTRIES) entries.removeFirst()
    }

    @Synchronized
    fun snapshot(): List<String> = entries.toList()

    @Synchronized
    fun clear() = entries.clear()
}
