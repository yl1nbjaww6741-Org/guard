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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGButton
import com.contentguard.app.ui.CGCard
import com.contentguard.app.ui.CGEyebrow
import com.contentguard.app.ui.CGHint
import com.contentguard.app.ui.CGLabel
import com.contentguard.app.ui.CGPageTitle
import com.contentguard.app.ui.CGSub
import com.contentguard.app.ui.CGToggle
import com.contentguard.app.ui.theme.CGColor

/** The safeguards that keep ContentGuard running, and the password that guards them - restyled to the redesign's token system (step 3), same live state and gating as step 2. */
@Composable
fun SecurityTab(
    prefs: PrefsRepository,
    serviceEnabled: Boolean,
    deviceAdminActive: Boolean,
    hasPassword: Boolean,
    onHasPasswordChange: (Boolean) -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onIgnoreBatteryOptimizations: () -> Unit,
    onEnableDeviceAdmin: () -> Unit,
    onOpenSecuritySettings: () -> Unit,
    applyOrChallenge: (weakening: Boolean, onCancelled: () -> Unit, apply: () -> Unit) -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGAppTitleRow() }
        item { CGPageTitle("Security") }
        item { CGSub("The safeguards that keep ContentGuard running - and the password that guards them.") }

        item { CGEyebrow("Safeguards") }

        item {
            CGCard {
                SafeguardRow(label = "Screen watching", on = serviceEnabled)
                CGHint("ContentGuard reads screen content only while a monitored app is open. Nothing works without this.")
                CGButton(
                    "Open accessibility settings",
                    onClick = onOpenAccessibilitySettings,
                    ghost = true,
                    small = true,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }

        item {
            CGCard {
                SafeguardRow(label = "Uninstall lock", on = deviceAdminActive)
                CGHint("Can't be force-stopped or uninstalled until this is turned off in Settings → Security → Device admin.")
                CGButton(
                    if (deviceAdminActive) "Manage device admin" else "Enable device admin",
                    onClick = if (deviceAdminActive) onOpenSecuritySettings else onEnableDeviceAdmin,
                    ghost = true,
                    small = true,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }

        item {
            CGCard {
                // No live on/off check plumbed in for this one yet (unlike
                // the two above) - that's step 4's "single state object"
                // work, alongside the seal. Just the label/hint/button for
                // now, matching what the pre-restyle card actually offered.
                CGLabel("Always running")
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
                    applyOrChallenge(hasPassword, {}) {
                        prefs.setPassword(newPassword)
                        onHasPasswordChange(true)
                    }
                },
            )
        }
    }
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
        CGLabel("Your password guards weakening - nothing else.")
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
