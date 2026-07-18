package com.contentguard.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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

/**
 * Inline password challenge for a single weakening action - deliberately a
 * dialog over the current screen, not a full-screen block the way the old
 * upfront Settings gate was, so only the specific change in question is
 * held up rather than the whole screen. Rendered once at the app root so
 * it can be triggered by a weakening action on any tab. See
 * ContentGuardApp.applyOrChallenge for what triggers this.
 */
@Composable
fun WeakenConfirmDialog(onVerify: (String) -> Boolean, onConfirmed: () -> Unit, onDismiss: () -> Unit) {
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Password required") },
        text = {
            Column {
                Text("This change weakens ContentGuard's protection. Enter your password to confirm.")
                Spacer(modifier = Modifier.height(12.dp))
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
            }
        },
        confirmButton = {
            Button(onClick = {
                if (onVerify(input)) onConfirmed() else error = true
            }) { Text("Confirm") }
        },
        dismissButton = {
            Button(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
