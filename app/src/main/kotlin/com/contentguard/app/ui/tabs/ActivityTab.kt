package com.contentguard.app.ui.tabs

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.util.DebugLogBuffer

/** Step 1 placeholder - since-reset metrics, reset/battery-info actions, debug log land here in step 2. */
@Composable
fun ActivityTab(prefs: PrefsRepository) {
    val context = LocalContext.current
    var usageStats by remember { mutableStateOf(prefs.getUsageStats()) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGAppTitleRow() }

        item {
            UsageStatsSection(
                stats = usageStats,
                onReset = {
                    prefs.resetUsageStats()
                    usageStats = prefs.getUsageStats()
                },
                onOpenBatterySettings = {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.fromParts("package", context.packageName, null)
                        },
                    )
                },
            )
        }

        item { DebugLogSection() }
    }
}

@Composable
private fun UsageStatsSection(
    stats: PrefsRepository.UsageStats,
    onReset: () -> Unit,
    onOpenBatterySettings: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Activity since last reset", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Not a real battery-percentage number - Android doesn't expose that to " +
                    "third-party apps. This counts the two operations that actually cost " +
                    "battery, as a proxy for load.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text("Screenshots captured: ${stats.screenshotCount}")
            Text("Classifier inferences: ${stats.inferenceCount}")
            Text("Avg inference latency: ${"%.0f".format(stats.avgInferenceMs)} ms")
            Text("Total inference time: ${"%.1f".format(stats.totalInferenceMs / 1000.0)} s")
            Text("Blocks triggered: ${stats.blockCount}")
            if (stats.sinceMillis > 0) {
                val elapsedMinutes = (System.currentTimeMillis() - stats.sinceMillis) / 60_000
                Text("Tracking for: $elapsedMinutes min")
            }
            Spacer(modifier = Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onReset) { Text("Reset") }
                Button(onClick = onOpenBatterySettings) { Text("System Battery Info") }
            }
        }
    }
}

@Composable
private fun DebugLogSection() {
    val context = LocalContext.current
    var lines by remember { mutableStateOf(DebugLogBuffer.snapshot()) }

    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Debug log", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Gate exits and classifier scores, mirrored from logcat - no adb needed. " +
                    "Refresh to update, Copy to paste elsewhere.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { lines = DebugLogBuffer.snapshot() }) { Text("Refresh") }
                Button(onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("ContentGuard debug log", lines.joinToString("\n")))
                }) { Text("Copy") }
                Button(onClick = {
                    DebugLogBuffer.clear()
                    lines = emptyList()
                }) { Text("Clear") }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Column(modifier = Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) {
                if (lines.isEmpty()) {
                    Text("No log entries yet.", style = MaterialTheme.typography.bodySmall)
                } else {
                    lines.asReversed().forEach { line ->
                        Text(line, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    }
                }
            }
        }
    }
}
