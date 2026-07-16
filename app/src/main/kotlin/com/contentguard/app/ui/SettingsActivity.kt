@file:OptIn(ExperimentalMaterial3Api::class)

package com.contentguard.app.ui

import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.contentguard.app.R
import com.contentguard.app.admin.ContentGuardDeviceAdminReceiver
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.scope.ScopeMode
import com.contentguard.app.service.ContentGuardService
import com.contentguard.app.ui.theme.ContentGuardTheme
import com.contentguard.app.util.DebugLogBuffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
    var unlocked by remember { mutableStateOf(!prefs.hasPassword()) }
    if (!unlocked) {
        PasswordUnlockScreen(onUnlock = { entered ->
            val ok = prefs.verifyPassword(entered)
            if (ok) unlocked = true
            ok
        })
        return
    }

    val context = LocalContext.current

    var mode by remember { mutableStateOf(prefs.mode) }
    var threshold by remember { mutableFloatStateOf(prefs.nsfwThreshold) }
    var dismissOnBlock by remember { mutableStateOf(prefs.dismissOnBlock) }
    var whitelist by remember { mutableStateOf(prefs.getWhitelist()) }
    var monitored by remember { mutableStateOf(prefs.getMonitoredSet()) }
    var serviceEnabled by remember { mutableStateOf(isAccessibilityServiceEnabled(context)) }
    var deviceAdminActive by remember { mutableStateOf(isDeviceAdminActive(context)) }
    var usageStats by remember { mutableStateOf(prefs.getUsageStats()) }
    var lockoutDurationMinutes by remember { mutableStateOf(prefs.lockoutDurationMinutes) }
    var strikesToLockout by remember { mutableStateOf(prefs.strikesToLockout) }
    var activeLockouts by remember { mutableStateOf(prefs.getActiveLockouts()) }
    var hasPassword by remember { mutableStateOf(prefs.hasPassword()) }
    var apps by remember { mutableStateOf(emptyList<AppEntry>()) }

    // Re-check accessibility-enabled/device-admin state and refresh usage
    // stats whenever we come back to the foreground - e.g. after the user
    // toggles accessibility or device admin in system Settings, or after
    // time has passed since the cascade last recorded activity.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                serviceEnabled = isAccessibilityServiceEnabled(context)
                deviceAdminActive = isDeviceAdminActive(context)
                usageStats = prefs.getUsageStats()
                activeLockouts = prefs.getActiveLockouts()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val deviceAdminLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) {
        deviceAdminActive = isDeviceAdminActive(context)
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

            item {
                DeviceAdminSection(
                    active = deviceAdminActive,
                    onEnable = {
                        val admin = ComponentName(context, ContentGuardDeviceAdminReceiver::class.java)
                        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
                            putExtra(
                                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                                context.getString(R.string.device_admin_description),
                            )
                        }
                        deviceAdminLauncher.launch(intent)
                    },
                    onOpenSecuritySettings = { context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) },
                )
            }

            item {
                PasswordSection(
                    hasPassword = hasPassword,
                    onSetPassword = { newPassword ->
                        prefs.setPassword(newPassword)
                        hasPassword = true
                    },
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
                LockoutSection(
                    durationMinutes = lockoutDurationMinutes,
                    onDurationChange = { lockoutDurationMinutes = it },
                    onDurationChangeFinished = { prefs.lockoutDurationMinutes = lockoutDurationMinutes },
                    strikesToLockout = strikesToLockout,
                    onStrikesChange = { strikesToLockout = it },
                    onStrikesChangeFinished = { prefs.strikesToLockout = strikesToLockout },
                    activeLockouts = activeLockouts,
                    onRefresh = { activeLockouts = prefs.getActiveLockouts() },
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
private fun DeviceAdminSection(
    active: Boolean,
    onEnable: () -> Unit,
    onOpenSecuritySettings: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = if (active) "Force-stop / uninstall protection is ON" else "Force-stop / uninstall protection is OFF",
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                if (active) {
                    "ContentGuard can't be force-stopped or uninstalled from Settings or Battery without first turning this off in Settings > Security > Device admin apps."
                } else {
                    "Uses Android's Device Admin API (not Device Owner - no factory reset needed). Grants no access to your data; it only makes ContentGuard resistant to Force Stop and uninstall."
                },
            )
            Spacer(modifier = Modifier.height(12.dp))
            if (active) {
                Button(onClick = onOpenSecuritySettings) { Text("Manage in Security Settings") }
            } else {
                Button(onClick = onEnable) { Text("Enable Protection") }
            }
        }
    }
}

@Composable
private fun LockoutSection(
    durationMinutes: Int,
    onDurationChange: (Int) -> Unit,
    onDurationChangeFinished: () -> Unit,
    strikesToLockout: Int,
    onStrikesChange: (Int) -> Unit,
    onStrikesChangeFinished: () -> Unit,
    activeLockouts: Map<String, Long>,
    onRefresh: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("$strikesToLockout-strikes lockout", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "$strikesToLockout explicit-content blocks for the same app within 15 minutes " +
                    "locks just that app for the duration below - switching back into it " +
                    "re-shows the block.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text("Strikes before lockout: $strikesToLockout")
            Slider(
                value = strikesToLockout.toFloat(),
                onValueChange = { onStrikesChange(it.toInt()) },
                onValueChangeFinished = onStrikesChangeFinished,
                valueRange = 1f..20f,
                steps = 18,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text("Lockout duration: $durationMinutes min")
            Slider(
                value = durationMinutes.toFloat(),
                onValueChange = { onDurationChange(it.toInt()) },
                onValueChangeFinished = onDurationChangeFinished,
                valueRange = 1f..30f,
                steps = 28,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Text("Currently locked out", style = MaterialTheme.typography.bodySmall)
                Button(onClick = onRefresh) { Text("Refresh") }
            }
            if (activeLockouts.isEmpty()) {
                Text("None", style = MaterialTheme.typography.bodySmall)
            } else {
                val now = System.currentTimeMillis()
                activeLockouts.forEach { (pkg, until) ->
                    val remainingSec = ((until - now) / 1000).coerceAtLeast(0)
                    Text("$pkg - ${remainingSec}s left", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun PasswordUnlockScreen(onUnlock: (String) -> Boolean) {
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Enter password", style = MaterialTheme.typography.titleLarge)
        Spacer(modifier = Modifier.height(16.dp))
        OutlinedTextField(
            value = input,
            onValueChange = { input = it; error = false },
            label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (error) {
            Spacer(modifier = Modifier.height(4.dp))
            Text("Incorrect password", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(modifier = Modifier.height(16.dp))
        Button(onClick = { if (!onUnlock(input)) error = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Unlock")
        }
    }
}

@Composable
private fun PasswordSection(hasPassword: Boolean, onSetPassword: (String) -> Unit) {
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf(false) }
    var mismatch by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = if (hasPassword) "App password is set" else "App password is not set",
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Required to open this Settings screen, and to reach the Accessibility or " +
                    "Device admin apps screens in system Settings - without it, any of those " +
                    "could be used to undo ContentGuard's protections.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedTextField(
                value = newPassword,
                onValueChange = { newPassword = it; saved = false; mismatch = false },
                label = { Text(if (hasPassword) "New password" else "Set password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = confirmPassword,
                onValueChange = { confirmPassword = it; saved = false; mismatch = false },
                label = { Text("Confirm") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (mismatch) {
                Spacer(modifier = Modifier.height(4.dp))
                Text("Passwords don't match", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (saved) {
                Spacer(modifier = Modifier.height(4.dp))
                Text("Saved", style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(12.dp))
            Button(onClick = {
                if (newPassword.isNotEmpty() && newPassword == confirmPassword) {
                    onSetPassword(newPassword)
                    newPassword = ""
                    confirmPassword = ""
                    saved = true
                } else {
                    mismatch = true
                }
            }) { Text("Save Password") }
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

private fun isDeviceAdminActive(context: Context): Boolean {
    val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    val admin = ComponentName(context, ContentGuardDeviceAdminReceiver::class.java)
    return dpm.isAdminActive(admin)
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
    // CATEGORY_HOME on top of CATEGORY_LAUNCHER: the home/launcher app
    // itself registers under HOME, not LAUNCHER (it doesn't have its own
    // app-drawer icon the way regular apps do), so without this it never
    // showed up in this list at all - meaning it couldn't be found or
    // whitelisted, even though it was still being monitored/screenshotted
    // like any other app under "Monitor all except whitelisted".
    val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
    return (pm.queryIntentActivities(launcherIntent, 0) + pm.queryIntentActivities(homeIntent, 0))
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
