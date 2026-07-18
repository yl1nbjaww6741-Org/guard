package com.contentguard.app.ui

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.text.TextUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.contentguard.app.R
import com.contentguard.app.admin.ContentGuardDeviceAdminReceiver
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.service.ContentGuardService
import com.contentguard.app.ui.tabs.ActivityTab
import com.contentguard.app.ui.tabs.AppsTab
import com.contentguard.app.ui.tabs.HomeTab
import com.contentguard.app.ui.tabs.RulesTab
import com.contentguard.app.ui.tabs.SecurityTab
import com.contentguard.app.ui.theme.CGColor

/**
 * Root of the redesigned Settings UI - five-tab bottom nav over a single
 * content area, replacing the old single long-scroll SettingsScreen (see
 * SettingsActivity.kt).
 *
 * Built as a plain Box overlay (content behind, nav bar on top) rather
 * than Scaffold's bottomBar slot, so the nav visually sits over the
 * scrolling content the way the prototype's absolutely-positioned `.nav`
 * does, instead of reserving its own non-overlapping strip. True
 * backdrop-blur (the prototype's `backdrop-filter:blur(14px)`) isn't
 * replicated - a semi-transparent fill stands in for it; not load-bearing
 * for either signature interaction, just a visual nicety left for later
 * polish.
 *
 * State that's shared across tabs - the weakening password challenge, and
 * the live accessibility/device-admin/password status the Security tab
 * (and, from step 4, the Home seal) both need - is hoisted here rather
 * than duplicated per tab, exactly as it lived in one place in the old
 * SettingsScreen. Everything else (thresholds, keywords, app list, usage
 * stats, etc.) stays local to the one tab that owns it.
 */
@Composable
fun ContentGuardApp(prefs: PrefsRepository) {
    val context = LocalContext.current
    var selected by remember { mutableStateOf(CGTab.HOME) }

    // Asymmetric protection: tightening a setting needs no password - only
    // loosening one (the direction that would actually let someone weaken
    // their own protection) prompts for it, inline at the point of that
    // specific change. See each tab's call sites for how "weakening" is
    // decided per setting.
    var pendingWeakenAction by remember { mutableStateOf<(() -> Unit)?>(null) }
    var pendingWeakenCancel by remember { mutableStateOf<(() -> Unit)?>(null) }

    fun applyOrChallenge(weakening: Boolean, onCancelled: () -> Unit = {}, apply: () -> Unit) {
        if (weakening && prefs.hasPassword()) {
            pendingWeakenAction = apply
            pendingWeakenCancel = onCancelled
        } else {
            apply()
        }
    }

    var serviceEnabled by remember { mutableStateOf(isAccessibilityServiceEnabled(context)) }
    var deviceAdminActive by remember { mutableStateOf(isDeviceAdminActive(context)) }
    var hasPassword by remember { mutableStateOf(prefs.hasPassword()) }

    // Re-check accessibility-enabled/device-admin state whenever we come
    // back to the foreground - e.g. after the user toggles either in
    // system Settings.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                serviceEnabled = isAccessibilityServiceEnabled(context)
                deviceAdminActive = isDeviceAdminActive(context)
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

    Box(modifier = Modifier.fillMaxSize().background(CGColor.Bg)) {
        Crossfade(targetState = selected, label = "tab") { tab ->
            when (tab) {
                CGTab.HOME -> HomeTab(prefs)
                CGTab.RULES -> RulesTab(prefs, applyOrChallenge = ::applyOrChallenge)
                CGTab.APPS -> AppsTab(prefs, applyOrChallenge = ::applyOrChallenge)
                CGTab.ACTIVITY -> ActivityTab(prefs)
                CGTab.SECURITY -> SecurityTab(
                    prefs = prefs,
                    serviceEnabled = serviceEnabled,
                    deviceAdminActive = deviceAdminActive,
                    hasPassword = hasPassword,
                    onHasPasswordChange = { hasPassword = it },
                    onOpenAccessibilitySettings = {
                        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    },
                    onIgnoreBatteryOptimizations = { requestIgnoreBatteryOptimizations(context) },
                    onEnableDeviceAdmin = {
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
                    onOpenSecuritySettings = {
                        context.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
                    },
                    applyOrChallenge = ::applyOrChallenge,
                )
            }
        }

        CGBottomNav(
            selected = selected,
            onSelect = { selected = it },
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    pendingWeakenAction?.let { action ->
        WeakenConfirmDialog(
            onVerify = { entered -> prefs.verifyPassword(entered) },
            onConfirmed = {
                action()
                pendingWeakenAction = null
                pendingWeakenCancel = null
            },
            onDismiss = {
                pendingWeakenCancel?.invoke()
                pendingWeakenAction = null
                pendingWeakenCancel = null
            },
        )
    }
}

@Composable
private fun CGBottomNav(selected: CGTab, onSelect: (CGTab) -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(CGColor.Bg.copy(alpha = 0.9f))
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(CGColor.Line))
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 8.dp)) {
            CGTab.entries.forEach { tab ->
                val isOn = tab == selected
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier
                        .weight(1f)
                        .clickable { onSelect(tab) }
                        .padding(vertical = 6.dp),
                ) {
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = tab.label,
                        tint = if (isOn) CGColor.Guard else CGColor.Faint,
                        modifier = Modifier.size(23.dp),
                    )
                    Text(
                        tab.label,
                        color = if (isOn) CGColor.Guard else CGColor.Faint,
                        fontSize = 10.sp,
                        fontWeight = MaterialTheme.typography.labelSmall.fontWeight,
                    )
                }
            }
        }
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
