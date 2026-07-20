package com.contentguard.app.ui

import android.animation.ValueAnimator
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
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.selection.selectable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
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
    // The serializable twin of pendingWeakenAction, used only if
    // delay-before-unlock is on - see PendingWeakenAction's doc comment for
    // why a raw closure can't be the thing that actually gets deferred.
    var pendingWeakenDescriptor by remember { mutableStateOf<PrefsRepository.PendingWeakenAction?>(null) }
    var activePendingUnlock by remember { mutableStateOf(prefs.getPendingUnlock()) }

    fun applyOrChallenge(
        weakening: Boolean,
        onCancelled: () -> Unit = {},
        pendingAction: PrefsRepository.PendingWeakenAction?,
        apply: () -> Unit,
    ) {
        if (weakening && prefs.hasPassword()) {
            pendingWeakenAction = apply
            pendingWeakenCancel = onCancelled
            pendingWeakenDescriptor = pendingAction
        } else {
            apply()
        }
    }

    // The seal (Home) and the safeguard cards (Security) must never show
    // conflicting answers for the same instant, so both read from this one
    // object rather than each computing/holding their own copies of the
    // three checks.
    var safeguards by remember {
        mutableStateOf(
            SafeguardState(
                accessibilityEnabled = isAccessibilityServiceEnabled(context),
                deviceAdminActive = isDeviceAdminActive(context),
                batteryOptimizationIgnored = isBatteryOptimizationIgnored(context),
            ),
        )
    }
    var hasPassword by remember { mutableStateOf(prefs.hasPassword()) }

    fun refreshSafeguards() {
        safeguards = SafeguardState(
            accessibilityEnabled = isAccessibilityServiceEnabled(context),
            deviceAdminActive = isDeviceAdminActive(context),
            batteryOptimizationIgnored = isBatteryOptimizationIgnored(context),
        )
    }

    // Re-check all three whenever we come back to the foreground - e.g.
    // after the user toggles accessibility/device-admin/battery exemption
    // in system Settings. Also re-evaluates a pending delay-before-unlock
    // action - it may have become eligible and already been applied by
    // ContentGuardService while this screen was backgrounded.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                refreshSafeguards()
                prefs.applyPendingWeakenActionIfEligible()
                activePendingUnlock = prefs.getPendingUnlock()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val deviceAdminLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult(),
    ) {
        refreshSafeguards()
    }

    // Respects the system "remove animations" accessibility setting -
    // ValueAnimator.areAnimatorsEnabled() reflects it directly, unlike
    // trying to read the animator-duration-scale setting by hand.
    val animationsEnabled = remember { ValueAnimator.areAnimatorsEnabled() }

    Box(modifier = Modifier.fillMaxSize().background(CGColor.Bg)) {
        Crossfade(
            targetState = selected,
            animationSpec = if (animationsEnabled) tween(300) else snap(),
            label = "tab",
            // The status bar sits over this content otherwise - each tab's
            // first item (a page title, or Home's seal) needs to clear it
            // now that there's no "ContentGuard" header row soaking up
            // that space at the top.
            modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars),
        ) { tab ->
            when (tab) {
                CGTab.HOME -> HomeTab(prefs, safeguards)
                CGTab.RULES -> RulesTab(prefs, applyOrChallenge = ::applyOrChallenge)
                CGTab.APPS -> AppsTab(prefs, applyOrChallenge = ::applyOrChallenge)
                CGTab.ACTIVITY -> ActivityTab(prefs)
                CGTab.SECURITY -> SecurityTab(
                    prefs = prefs,
                    safeguards = safeguards,
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
                    pendingUnlock = activePendingUnlock,
                    onCancelPendingUnlock = {
                        prefs.clearPendingWeakenAction()
                        activePendingUnlock = null
                    },
                    onPendingUnlockTick = {
                        // Called on the SecurityTab's own once-a-second
                        // ticker while a pending unlock is showing, so it
                        // resolves live if eligibleAt passes while this
                        // screen is open, not just next time the app resumes.
                        prefs.applyPendingWeakenActionIfEligible()
                        activePendingUnlock = prefs.getPendingUnlock()
                    },
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
                val descriptor = pendingWeakenDescriptor
                if (prefs.delayBeforeUnlockEnabled && descriptor != null) {
                    // Correct password, but the delay-before-unlock cooldown
                    // means the change doesn't take effect yet - persisted
                    // so it survives restart/force-stop/reboot; actually
                    // applied later by ContentGuardService once eligible
                    // (see PrefsRepository.applyPendingWeakenActionIfEligible).
                    val eligibleAt = System.currentTimeMillis() + prefs.delayBeforeUnlockMinutes * 60_000L
                    prefs.setPendingWeakenAction(descriptor, eligibleAt)
                    activePendingUnlock = prefs.getPendingUnlock()
                } else {
                    action()
                }
                pendingWeakenAction = null
                pendingWeakenCancel = null
                pendingWeakenDescriptor = null
            },
            onDismiss = {
                pendingWeakenCancel?.invoke()
                pendingWeakenAction = null
                pendingWeakenCancel = null
                pendingWeakenDescriptor = null
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
                        // selectable, not plain clickable, so TalkBack
                        // announces this as a tab and reads which one is
                        // currently selected.
                        .selectable(selected = isOn, onClick = { onSelect(tab) }, role = Role.Tab)
                        .padding(vertical = 6.dp),
                ) {
                    Icon(
                        imageVector = tab.icon,
                        // null, not tab.label - the selectable() below
                        // merges this with the visible Text label right
                        // after it, so a contentDescription here would
                        // just make TalkBack read the tab's name twice.
                        contentDescription = null,
                        tint = if (isOn) CGColor.Guard else CGColor.Faint,
                        modifier = Modifier.size(23.dp),
                    )
                    Text(
                        tab.label,
                        color = if (isOn) CGColor.Guard else CGColor.Faint,
                        fontSize = 10.sp,
                        fontWeight = MaterialTheme.typography.labelSmall.fontWeight,
                        letterSpacing = 0.01.em,
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

private fun isBatteryOptimizationIgnored(context: Context): Boolean {
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return powerManager.isIgnoringBatteryOptimizations(context.packageName)
}
