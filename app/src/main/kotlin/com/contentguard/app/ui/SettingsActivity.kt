@file:OptIn(ExperimentalMaterial3Api::class)

package com.contentguard.app.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.scope.ScopeMode
import com.contentguard.app.service.ContentGuardService
import com.contentguard.app.ui.theme.ContentGuardTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = PrefsRepository(applicationContext)
        setContent {
            ContentGuardTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    SettingsScreen(prefs)
                }
            }
        }
    }
}

private data class AppEntry(val packageName: String, val label: String, val icon: ImageBitmap?)

@Composable
private fun SettingsScreen(prefs: PrefsRepository) {
    val context = LocalContext.current

    var mode by remember { mutableStateOf(prefs.mode) }
    var threshold by remember { mutableFloatStateOf(prefs.nsfwThreshold) }
    var dismissOnBlock by remember { mutableStateOf(prefs.dismissOnBlock) }
    var whitelist by remember { mutableStateOf(prefs.getWhitelist()) }
    var monitored by remember { mutableStateOf(prefs.getMonitoredSet()) }
    var serviceEnabled by remember { mutableStateOf(isAccessibilityServiceEnabled(context)) }
    var apps by remember { mutableStateOf(emptyList<AppEntry>()) }

    // Re-check accessibility-enabled state whenever we come back to the
    // foreground - e.g. after the user toggles it in system Settings.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                serviceEnabled = isAccessibilityServiceEnabled(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(Unit) {
        apps = withContext(Dispatchers.Default) { loadLaunchableApps(context) }
    }

    fun isMonitored(pkg: String): Boolean = when (mode) {
        ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST -> pkg !in whitelist
        ScopeMode.MONITOR_ONLY_LISTED -> pkg in monitored
    }

    fun setMonitored(pkg: String, monitor: Boolean) {
        when (mode) {
            ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST -> {
                // "Monitor" off means "add to whitelist" (trusted).
                prefs.setWhitelisted(pkg, !monitor)
                whitelist = prefs.getWhitelist()
            }
            ScopeMode.MONITOR_ONLY_LISTED -> {
                prefs.setMonitored(pkg, monitor)
                monitored = prefs.getMonitoredSet()
            }
        }
    }

    Scaffold(topBar = { TopAppBar(title = { Text("ContentGuard") }) }) { padding ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
            item {
                AccessibilityStatusCard(
                    enabled = serviceEnabled,
                    onOpenSettings = { context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                    onIgnoreBatteryOptimizations = { requestIgnoreBatteryOptimizations(context) },
                )
            }

            item { ScopeModeSection(mode = mode, onModeChange = { mode = it; prefs.mode = it }) }

            item {
                ThresholdSection(
                    threshold = threshold,
                    onThresholdChange = { threshold = it },
                    onThresholdChangeFinished = { prefs.nsfwThreshold = threshold },
                    dismissOnBlock = dismissOnBlock,
                    onDismissOnBlockChange = { dismissOnBlock = it; prefs.dismissOnBlock = it },
                )
            }

            item {
                Text(
                    text = "Apps",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(16.dp),
                )
            }

            items(apps, key = { it.packageName }) { app ->
                AppRow(
                    app = app,
                    monitored = isMonitored(app.packageName),
                    onToggle = { setMonitored(app.packageName, it) },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun AccessibilityStatusCard(
    enabled: Boolean,
    onOpenSettings: () -> Unit,
    onIgnoreBatteryOptimizations: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = if (enabled) "Accessibility service is ON" else "Accessibility service is OFF",
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text("ContentGuard cannot see or block anything until this is enabled.")
            Spacer(modifier = Modifier.height(12.dp))
            Button(onClick = onOpenSettings) { Text("Open Accessibility Settings") }
            Spacer(modifier = Modifier.height(8.dp))
            Button(onClick = onIgnoreBatteryOptimizations) { Text("Ignore Battery Optimizations") }
        }
    }
}

@Composable
private fun ScopeModeSection(mode: ScopeMode, onModeChange: (ScopeMode) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Scope mode", style = MaterialTheme.typography.titleMedium)
            ScopeModeRow(
                label = "Monitor all apps except whitelisted",
                selected = mode == ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST,
                onClick = { onModeChange(ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST) },
            )
            ScopeModeRow(
                label = "Monitor only listed apps",
                selected = mode == ScopeMode.MONITOR_ONLY_LISTED,
                onClick = { onModeChange(ScopeMode.MONITOR_ONLY_LISTED) },
            )
        }
    }
}

@Composable
private fun ScopeModeRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label)
    }
}

@Composable
private fun ThresholdSection(
    threshold: Float,
    onThresholdChange: (Float) -> Unit,
    onThresholdChangeFinished: () -> Unit,
    dismissOnBlock: Boolean,
    onDismissOnBlockChange: (Boolean) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("NSFW threshold: ${"%.2f".format(threshold)}", style = MaterialTheme.typography.titleMedium)
            Slider(
                value = threshold,
                onValueChange = onThresholdChange,
                onValueChangeFinished = onThresholdChangeFinished,
                valueRange = 0f..1f,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Text("Auto-dismiss (go back) on block")
                Switch(checked = dismissOnBlock, onCheckedChange = onDismissOnBlockChange)
            }
        }
    }
}

@Composable
private fun AppRow(app: AppEntry, monitored: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            if (app.icon != null) {
                Image(bitmap = app.icon, contentDescription = null, modifier = Modifier.size(32.dp))
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(app.label)
        }
        Switch(checked = monitored, onCheckedChange = onToggle)
    }
}

private fun isAccessibilityServiceEnabled(context: Context): Boolean {
    val expected = ComponentName(context, ContentGuardService::class.java)
    val enabledServices = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false

    val splitter = TextUtils.SimpleStringSplitter(':')
    splitter.setString(enabledServices)
    while (splitter.hasNext()) {
        val component = ComponentName.unflattenFromString(splitter.next())
        if (component == expected) return true
    }
    return false
}

private fun requestIgnoreBatteryOptimizations(context: Context) {
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (powerManager.isIgnoringBatteryOptimizations(context.packageName)) return
    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
    }
    context.startActivity(intent)
}

@Suppress("DEPRECATION")
private fun loadLaunchableApps(context: Context): List<AppEntry> {
    val pm = context.packageManager
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(intent, 0)
        .distinctBy { it.activityInfo.packageName }
        .filter { it.activityInfo.packageName != context.packageName }
        .map { info ->
            val icon = runCatching { info.loadIcon(pm).toBitmap(96, 96).asImageBitmap() }.getOrNull()
            AppEntry(
                packageName = info.activityInfo.packageName,
                label = info.loadLabel(pm).toString(),
                icon = icon,
            )
        }
        .sortedBy { it.label.lowercase() }
}
