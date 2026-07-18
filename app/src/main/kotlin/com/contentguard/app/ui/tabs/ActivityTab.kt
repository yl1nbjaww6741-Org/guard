package com.contentguard.app.ui.tabs

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGButton
import com.contentguard.app.ui.CGEyebrow
import com.contentguard.app.ui.CGMetric
import com.contentguard.app.ui.CGMetricsRow
import com.contentguard.app.ui.CGPageTitle
import com.contentguard.app.ui.CGSub
import com.contentguard.app.ui.theme.CGColor
import com.contentguard.app.ui.theme.JetBrainsMono
import com.contentguard.app.util.DebugLogBuffer
import androidx.compose.material3.Text

/** A load proxy, not a battery reading, plus the mirrored debug log - restyled to the redesign's token system (step 3), same PrefsRepository state as step 2. */
@Composable
fun ActivityTab(prefs: PrefsRepository) {
    val context = LocalContext.current
    var usageStats by remember { mutableStateOf(prefs.getUsageStats()) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGAppTitleRow() }
        item { CGPageTitle("Activity") }
        item {
            CGSub(
                "A load proxy, not a battery reading — Android hides that from apps. " +
                    "These are the two operations that actually cost power.",
            )
        }

        item {
            val sinceLabel = if (usageStats.sinceMillis > 0) {
                val elapsedMinutes = (System.currentTimeMillis() - usageStats.sinceMillis) / 60_000
                "Since last reset · $elapsedMinutes min"
            } else {
                "Since last reset"
            }
            CGEyebrow(sinceLabel)
        }

        item {
            CGMetricsRow {
                CGMetric(number = "${usageStats.screenshotCount}", unit = null, kicker = "Screens")
                CGMetric(number = "${usageStats.inferenceCount}", unit = null, kicker = "Inferences")
                CGMetric(number = "%.0f".format(usageStats.avgInferenceMs), unit = "ms", kicker = "Avg latency")
            }
        }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 12.dp)) {
                CGButton("Reset counters", onClick = {
                    prefs.resetUsageStats()
                    usageStats = prefs.getUsageStats()
                }, ghost = true, small = true)
                CGButton(
                    "System battery info",
                    onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = Uri.fromParts("package", context.packageName, null)
                            },
                        )
                    },
                    ghost = true,
                    small = true,
                )
            }
        }

        item { CGEyebrow("Debug log") }
        item { CGSub("Gate exits and classifier scores, mirrored from logcat. No ADB needed.") }

        item { DebugLogSection() }
    }
}

@Composable
private fun DebugLogSection() {
    val context = LocalContext.current
    var lines by remember { mutableStateOf(DebugLogBuffer.snapshot()) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(CGColor.LogBg, RoundedCornerShape(13.dp))
            .padding(14.dp)
            .heightIn(max = 260.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        if (lines.isEmpty()) {
            Text("No log entries yet.", color = CGColor.Dim, fontFamily = JetBrainsMono, fontSize = 11.sp)
        } else {
            lines.asReversed().forEach { line ->
                Text(
                    formatLogLine(line),
                    fontFamily = JetBrainsMono,
                    fontSize = 11.sp,
                    lineHeight = 18.7.sp,
                )
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 12.dp)) {
        CGButton("Refresh", onClick = { lines = DebugLogBuffer.snapshot() }, small = true)
        CGButton("Copy", onClick = {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("ContentGuard debug log", lines.joinToString("\n")))
        }, ghost = true, small = true)
        CGButton("Clear", onClick = {
            DebugLogBuffer.clear()
            lines = emptyList()
        }, ghost = true, small = true)
    }
}

/**
 * Colors a `DebugLogBuffer` line the way the prototype's `.log` block does:
 * timestamp faint, GATE5_* (throttled/skipped) attention, GATE_SETTINGS_GUARD
 * guard, and any block-related word breach - everything else stays the
 * log's default dim, same as the prototype's `.gate6` (no visible change).
 */
private fun formatLogLine(line: String) = buildAnnotatedString {
    val spaceIndex = line.indexOf(' ')
    if (spaceIndex <= 0) {
        append(line)
        return@buildAnnotatedString
    }
    withStyle(SpanStyle(color = CGColor.Faint)) { append(line.substring(0, spaceIndex)) }
    val rest = line.substring(spaceIndex)
    val gateWordRegex = Regex("GATE\\w*|block(ed)?", RegexOption.IGNORE_CASE)
    var cursor = 0
    for (match in gateWordRegex.findAll(rest)) {
        if (match.range.first > cursor) {
            withStyle(SpanStyle(color = CGColor.Dim)) { append(rest.substring(cursor, match.range.first)) }
        }
        val word = match.value
        val color = when {
            word.startsWith("GATE_SETTINGS", ignoreCase = true) -> CGColor.Guard
            word.startsWith("GATE5", ignoreCase = true) -> CGColor.Attention
            word.contains("block", ignoreCase = true) -> CGColor.Breach
            else -> CGColor.Dim
        }
        withStyle(SpanStyle(color = color)) { append(word) }
        cursor = match.range.last + 1
    }
    if (cursor < rest.length) {
        withStyle(SpanStyle(color = CGColor.Dim)) { append(rest.substring(cursor)) }
    }
}
