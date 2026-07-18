package com.contentguard.app.ui.tabs

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance

/** Step 1 placeholder - the three safeguard cards + app-password card land here in step 2 / step 4 (live binding). */
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

        item {
            AccessibilityStatusCard(
                enabled = serviceEnabled,
                onOpenSettings = onOpenAccessibilitySettings,
                onIgnoreBatteryOptimizations = onIgnoreBatteryOptimizations,
            )
        }

        item {
            DeviceAdminSection(
                active = deviceAdminActive,
                onEnable = onEnableDeviceAdmin,
                onOpenSecuritySettings = onOpenSecuritySettings,
            )
        }

        item {
            PasswordSection(
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
                "Required to reach the Accessibility or Device admin apps screens in system " +
                    "Settings, and to make any change here that weakens protection (raising " +
                    "the NSFW threshold, whitelisting an app, removing a keyword, etc.) - " +
                    "tightening a setting never needs it. Viewing this screen doesn't need it " +
                    "either.",
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
