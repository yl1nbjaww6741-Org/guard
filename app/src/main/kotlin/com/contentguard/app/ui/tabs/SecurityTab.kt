package com.contentguard.app.ui.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGButton
import com.contentguard.app.ui.CGCard
import com.contentguard.app.ui.CGEyebrow
import com.contentguard.app.ui.CGGatedButton
import com.contentguard.app.ui.CGHint
import com.contentguard.app.ui.CGLabel
import com.contentguard.app.ui.CGPageTitle
import com.contentguard.app.ui.CGSegmented
import com.contentguard.app.ui.CGSub
import com.contentguard.app.ui.CGToggle
import com.contentguard.app.ui.CGVal
import com.contentguard.app.ui.GateChallenge
import com.contentguard.app.ui.SafeguardState
import com.contentguard.app.ui.theme.CGColor
import kotlinx.coroutines.delay

/** The safeguards that keep ContentGuard running, and the password that guards them - live pillar state (step 4) shared with the Home seal via one SafeguardState object. */
@Composable
fun SecurityTab(
    prefs: PrefsRepository,
    safeguards: SafeguardState,
    hasPassword: Boolean,
    onHasPasswordChange: (Boolean) -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onIgnoreBatteryOptimizations: () -> Unit,
    onEnableDeviceAdmin: () -> Unit,
    onOpenSecuritySettings: () -> Unit,
    applyOrChallenge: GateChallenge,
    pendingUnlock: PrefsRepository.PendingUnlock?,
    onCancelPendingUnlock: () -> Unit,
    onPendingUnlockTick: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGPageTitle("Security") }
        item { CGSub("The safeguards that keep ContentGuard running — and the password that guards them.") }

        item { CGEyebrow("Safeguards") }

        item {
            CGCard {
                SafeguardRow(label = "Screen watching", on = safeguards.accessibilityEnabled)
                CGHint("ContentGuard reads screen content only while a monitored app is open. Nothing works without this.")
                // Reaching this screen at all is gated - it's where
                // accessibility would actually get turned off, regardless
                // of whether it's currently on or off.
                CGGatedButton(
                    "Open accessibility settings",
                    applyOrChallenge = applyOrChallenge,
                    onConfirmed = onOpenAccessibilitySettings,
                    ghost = true,
                    small = true,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }

        item {
            CGCard {
                SafeguardRow(label = "Uninstall lock", on = safeguards.deviceAdminActive)
                CGHint("Can't be force-stopped or uninstalled until this is turned off in Settings → Security → Device admin.")
                if (safeguards.deviceAdminActive) {
                    // Reaching the device-admin apps list is gated - it's
                    // where this would actually get turned off.
                    CGGatedButton(
                        "Manage device admin",
                        applyOrChallenge = applyOrChallenge,
                        onConfirmed = onOpenSecuritySettings,
                        ghost = true,
                        small = true,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                } else {
                    // Bootstrapping device admin is hardening (adding a
                    // protection that wasn't there) - free, like setting a
                    // password for the first time.
                    CGButton(
                        "Enable device admin",
                        onClick = onEnableDeviceAdmin,
                        ghost = true,
                        small = true,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        }

        item {
            CGCard {
                SafeguardRow(label = "Always running", on = safeguards.batteryOptimizationIgnored)
                CGHint("Exempt from battery optimisation so the service can't be quietly killed.")
                CGButton(
                    "Ignore battery optimizations",
                    onClick = onIgnoreBatteryOptimizations,
                    ghost = true,
                    small = true,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }

        item { CGEyebrow("Password") }

        item {
            PasswordCard(
                hasPassword = hasPassword,
                onSetPassword = { newPassword ->
                    // Changing an *existing* password always needs the
                    // current one first, regardless of the harden/weaken
                    // classification everything else uses - otherwise
                    // anyone could set their own known password and use it
                    // to unlock every other weakening action from then on.
                    // Setting a password where none exists yet is the
                    // bootstrap case - that's hardening (adding a
                    // protection that wasn't there), so it's free.
                    // The pending descriptor stores a precomputed hash, never
                    // the raw password - see PendingWeakenAction's doc
                    // comment on SetPasswordHash for why.
                    applyOrChallenge(hasPassword, {}, PrefsRepository.PendingWeakenAction.SetPasswordHash(prefs.hashPasswordForPending(newPassword))) {
                        prefs.setPassword(newPassword)
                        onHasPasswordChange(true)
                    }
                },
            )
        }

        item { CGEyebrow("Delay before unlock") }

        if (pendingUnlock != null) {
            item {
                PendingUnlockCard(pendingUnlock = pendingUnlock, onCancel = onCancelPendingUnlock, onTick = onPendingUnlockTick)
            }
        }

        item {
            DelayBeforeUnlockCard(prefs = prefs, applyOrChallenge = applyOrChallenge)
        }
    }
}

/**
 * Anti-impulse cooldown: after a correct password, protection doesn't
 * weaken immediately - it stays full-strength until [pendingUnlock]'s
 * eligible-at time, actually applied by ContentGuardService (see
 * PrefsRepository.applyPendingWeakenActionIfEligible). [onTick] re-checks
 * eligibility once a second while this card is showing, so a cooldown that
 * finishes while the user is looking at this exact screen resolves live
 * instead of needing to leave and come back.
 */
@Composable
private fun PendingUnlockCard(pendingUnlock: PrefsRepository.PendingUnlock, onCancel: () -> Unit, onTick: () -> Unit) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pendingUnlock) {
        while (true) {
            delay(1000)
            onTick()
            now = System.currentTimeMillis()
        }
    }

    val remainingMs = (pendingUnlock.eligibleAtMillis - now).coerceAtLeast(0)
    CGCard {
        CGLabel("A change is waiting")
        CGHint(
            "Protection stays full-strength until this cooldown ends. Re-entering your password " +
                "doesn't shorten it - only Cancel does.",
        )
        Row(modifier = Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Remaining", color = CGColor.Dim, fontSize = 13.sp)
            CGVal(formatRemaining(remainingMs))
        }
        CGButton("Cancel", onClick = onCancel, ghost = true, small = true, modifier = Modifier.padding(top = 12.dp))
    }
}

private fun formatRemaining(ms: Long): String {
    val totalSeconds = ms / 1000
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return when {
        hours > 0 -> "%dh %02dm".format(hours, minutes)
        minutes > 0 -> "%dm %02ds".format(minutes, seconds)
        else -> "%ds".format(seconds)
    }
}

@Composable
private fun DelayBeforeUnlockCard(prefs: PrefsRepository, applyOrChallenge: GateChallenge) {
    var enabled by remember { mutableStateOf(prefs.delayBeforeUnlockEnabled) }
    var minutes by remember { mutableStateOf(prefs.delayBeforeUnlockMinutes) }

    CGCard {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                CGLabel("Delay before unlock")
                CGHint(
                    "An anti-impulse cooldown: after entering the correct password, protection stays " +
                        "full-strength for the delay below before the change actually takes effect.",
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            CGToggle(
                checked = enabled,
                onCheckedChange = { newValue ->
                    if (newValue) {
                        // Turning the cooldown ON is hardening - free, same
                        // as every other "add a protection" move elsewhere.
                        enabled = true
                        prefs.delayBeforeUnlockEnabled = true
                    } else {
                        // Turning it OFF removes the cooldown itself - the
                        // weakening move for this feature specifically, so
                        // it needs the password (and is itself deferrable)
                        // exactly like everything else the cooldown
                        // protects. Otherwise the whole feature could be
                        // bypassed by just switching it off first.
                        applyOrChallenge(true, { enabled = true }, PrefsRepository.PendingWeakenAction.SetDelayBeforeUnlockEnabled(false)) {
                            enabled = false
                            prefs.delayBeforeUnlockEnabled = false
                        }
                    }
                },
            )
        }
        if (enabled) {
            Text("Delay", color = CGColor.Dim, fontSize = 13.sp, modifier = Modifier.padding(top = 14.dp, bottom = 6.dp))
            CGSegmented(
                options = PrefsRepository.DELAY_BEFORE_UNLOCK_PRESETS_MINUTES.map { formatDelayMinutes(it) },
                selectedIndex = PrefsRepository.DELAY_BEFORE_UNLOCK_PRESETS_MINUTES.indexOf(minutes).coerceAtLeast(0),
                onSelect = { index ->
                    val newValue = PrefsRepository.DELAY_BEFORE_UNLOCK_PRESETS_MINUTES[index]
                    val oldValue = minutes
                    // Shortening the delay weakens the cooldown; lengthening
                    // it is free, same asymmetry as every slider elsewhere.
                    applyOrChallenge(newValue < oldValue, { minutes = oldValue }, PrefsRepository.PendingWeakenAction.SetDelayBeforeUnlockMinutes(newValue)) {
                        minutes = newValue
                        prefs.delayBeforeUnlockMinutes = newValue
                    }
                },
            )
        }
    }
}

private fun formatDelayMinutes(minutes: Int): String = when {
    minutes >= 1440 && minutes % 1440 == 0 -> "${minutes / 1440}d"
    minutes >= 60 && minutes % 60 == 0 -> "${minutes / 60}h"
    else -> "${minutes}m"
}

/**
 * `.tog` next to a safeguard's name - reflects the real, live
 * accessibility/device-admin/battery-exemption state. Unlike the
 * prototype's demo toggle, it isn't a free-standing switch: Android
 * doesn't let one app flip another app's accessibility/device-admin/
 * battery-exemption state directly, so tapping it (like tapping the
 * card's own button) only opens the place that state actually lives -
 * it can't itself apply the change.
 */
@Composable
private fun SafeguardRow(label: String, on: Boolean, onToggle: (() -> Unit)? = null) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        CGLabel(label)
        CGToggle(checked = on, onCheckedChange = { onToggle?.invoke() })
    }
}

@Composable
private fun PasswordCard(hasPassword: Boolean, onSetPassword: (String) -> Unit) {
    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf(false) }
    var mismatch by remember { mutableStateOf(false) }

    CGCard {
        CGLabel("Your password guards weakening — nothing else.")
        CGHint(
            "It's asked before raising the threshold, allowing an app, removing a keyword, or " +
                "opening the accessibility and device-admin screens. Tightening protection never " +
                "asks. Viewing any screen is free.",
        )
        Column(modifier = Modifier.padding(top = 14.dp)) {
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
                Text(
                    "Passwords don't match",
                    color = CGColor.Breach,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            if (saved) {
                Text("Saved", color = CGColor.Guard, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp))
            }
            CGButton(
                "Save password",
                onClick = {
                    if (newPassword.isNotEmpty() && newPassword == confirmPassword) {
                        onSetPassword(newPassword)
                        newPassword = ""
                        confirmPassword = ""
                        saved = true
                    } else {
                        mismatch = true
                    }
                },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}
