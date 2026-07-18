package com.contentguard.app.ui.tabs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.contentguard.app.detect.KeywordBlocklist
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance

/** Step 1 placeholder - NSFW threshold, capture cadence, keywords, go-back-on-block, lockout land here in step 2. */
@Composable
fun RulesTab(prefs: PrefsRepository, applyOrChallenge: (weakening: Boolean, onCancelled: () -> Unit, apply: () -> Unit) -> Unit) {
    var threshold by remember { mutableFloatStateOf(prefs.nsfwThreshold) }
    var dismissOnBlock by remember { mutableStateOf(prefs.dismissOnBlock) }
    var captureThrottleMs by remember { mutableStateOf(prefs.captureThrottleMs) }
    var explicitKeywords by remember { mutableStateOf(prefs.getExplicitKeywords()) }
    var explicitKeywordsCustomized by remember { mutableStateOf(prefs.explicitKeywordsAreCustomized()) }
    var lockoutDurationMinutes by remember { mutableStateOf(prefs.lockoutDurationMinutes) }
    var strikesToLockout by remember { mutableStateOf(prefs.strikesToLockout) }
    var activeLockouts by remember { mutableStateOf(prefs.getActiveLockouts()) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGAppTitleRow() }

        item {
            ThresholdSection(
                threshold = threshold,
                onThresholdChange = { threshold = it },
                onThresholdChangeFinished = {
                    val newValue = threshold
                    val oldValue = prefs.nsfwThreshold
                    // Lower threshold blocks more (score < threshold passes
                    // as safe) - raising it is the weakening move.
                    applyOrChallenge(newValue > oldValue, { threshold = oldValue }) {
                        prefs.nsfwThreshold = newValue
                    }
                },
                dismissOnBlock = dismissOnBlock,
                // Not a strictness lever - doesn't change what gets
                // blocked, only the UX after a block already happened.
                onDismissOnBlockChange = { dismissOnBlock = it; prefs.dismissOnBlock = it },
            )
        }

        item {
            CaptureCadenceSection(
                throttleMs = captureThrottleMs,
                onThrottleChange = { captureThrottleMs = it },
                onThrottleChangeFinished = {
                    val newValue = captureThrottleMs
                    val oldValue = prefs.captureThrottleMs
                    // Lower cadence = faster/more frequent capture = stricter.
                    applyOrChallenge(newValue > oldValue, { captureThrottleMs = oldValue }) {
                        prefs.captureThrottleMs = newValue
                    }
                },
            )
        }

        item {
            KeywordBlocklistSection(
                keywords = explicitKeywords,
                customized = explicitKeywordsCustomized,
                onAdd = { keyword ->
                    // Adding a keyword is hardening - more terms blocked.
                    prefs.addExplicitKeyword(keyword)
                    explicitKeywords = prefs.getExplicitKeywords()
                    explicitKeywordsCustomized = prefs.explicitKeywordsAreCustomized()
                },
                onRemove = { keyword ->
                    // Removing one is weakening - fewer terms blocked.
                    applyOrChallenge(true, {}) {
                        prefs.removeExplicitKeyword(keyword)
                        explicitKeywords = prefs.getExplicitKeywords()
                        explicitKeywordsCustomized = prefs.explicitKeywordsAreCustomized()
                    }
                },
                onResetToDefault = {
                    // Could go either direction depending on how the list
                    // was customized - treated as weakening since that's
                    // the safer default assumption.
                    applyOrChallenge(true, {}) {
                        prefs.resetExplicitKeywordsToDefault()
                        explicitKeywords = prefs.getExplicitKeywords()
                        explicitKeywordsCustomized = prefs.explicitKeywordsAreCustomized()
                    }
                },
            )
        }

        item {
            LockoutSection(
                durationMinutes = lockoutDurationMinutes,
                onDurationChange = { lockoutDurationMinutes = it },
                onDurationChangeFinished = {
                    val newValue = lockoutDurationMinutes
                    val oldValue = prefs.lockoutDurationMinutes
                    // Longer lockout is stricter - shortening it is the
                    // weakening move.
                    applyOrChallenge(newValue < oldValue, { lockoutDurationMinutes = oldValue }) {
                        prefs.lockoutDurationMinutes = newValue
                    }
                },
                strikesToLockout = strikesToLockout,
                onStrikesChange = { strikesToLockout = it },
                onStrikesChangeFinished = {
                    val newValue = strikesToLockout
                    val oldValue = prefs.strikesToLockout
                    // Fewer strikes needed locks out sooner - stricter.
                    // Raising the count is the weakening move.
                    applyOrChallenge(newValue > oldValue, { strikesToLockout = oldValue }) {
                        prefs.strikesToLockout = newValue
                    }
                },
                activeLockouts = activeLockouts,
                onRefresh = { activeLockouts = prefs.getActiveLockouts() },
            )
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
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Auto-dismiss (go back) on block")
                Switch(checked = dismissOnBlock, onCheckedChange = onDismissOnBlockChange)
            }
        }
    }
}

@Composable
private fun CaptureCadenceSection(
    throttleMs: Long,
    onThrottleChange: (Long) -> Unit,
    onThrottleChangeFinished: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Capture cadence: ${throttleMs}ms", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Minimum time between screenshots while a monitored app is open. Lower is " +
                    "faster detection, higher saves battery - the periodic static-content " +
                    "recheck follows this automatically, ${PrefsRepository.STATIC_RECHECK_MARGIN_MS}ms behind it.",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Slider(
                value = throttleMs.toFloat(),
                onValueChange = { onThrottleChange(it.toLong()) },
                onValueChangeFinished = onThrottleChangeFinished,
                valueRange = PrefsRepository.MIN_CAPTURE_THROTTLE_MS.toFloat()..PrefsRepository.MAX_CAPTURE_THROTTLE_MS.toFloat(),
            )
        }
    }
}

@Composable
private fun KeywordBlocklistSection(
    keywords: Set<String>,
    customized: Boolean,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    onResetToDefault: () -> Unit,
) {
    var newKeyword by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Explicit search keywords (${keywords.size})", style = MaterialTheme.typography.titleMedium)
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Blocks a browser immediately when one of these is typed into an address bar " +
                    "or search box, before any page loads. Starts from a built-in default list " +
                    "(${KeywordBlocklist.EXPLICIT_KEYWORDS.size} terms) - add or remove as needed below.",
                style = MaterialTheme.typography.bodySmall,
            )
            if (customized) {
                Spacer(modifier = Modifier.height(4.dp))
                Text("Customized - no longer the built-in default list.", style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = newKeyword,
                    onValueChange = { newKeyword = it },
                    label = { Text("Add keyword") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Button(onClick = {
                    if (newKeyword.isNotBlank()) {
                        onAdd(newKeyword)
                        newKeyword = ""
                    }
                }) { Text("Add") }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (expanded) "▾ Hide list" else "▸ Show list",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.clickable { expanded = !expanded },
                )
                Button(onClick = onResetToDefault, enabled = customized) { Text("Reset to default") }
            }
            if (expanded) {
                Spacer(modifier = Modifier.height(8.dp))
                Column(modifier = Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState())) {
                    keywords.sorted().forEach { keyword ->
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(keyword, style = MaterialTheme.typography.bodySmall)
                            Text(
                                "Remove",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.clickable { onRemove(keyword) },
                            )
                        }
                    }
                }
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
                verticalAlignment = Alignment.CenterVertically,
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
