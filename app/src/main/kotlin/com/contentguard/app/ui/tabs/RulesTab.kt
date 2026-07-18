package com.contentguard.app.ui.tabs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.contentguard.app.detect.KeywordBlocklist
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGButton
import com.contentguard.app.ui.CGCard
import com.contentguard.app.ui.CGEyebrow
import com.contentguard.app.ui.CGGateChip
import com.contentguard.app.ui.CGHint
import com.contentguard.app.ui.CGLabel
import com.contentguard.app.ui.CGPageTitle
import com.contentguard.app.ui.CGSub
import com.contentguard.app.ui.CGToggle
import com.contentguard.app.ui.CGVal
import com.contentguard.app.ui.theme.CGColor
import com.contentguard.app.ui.theme.JetBrainsMono

/** How hard ContentGuard blocks, and what it blocks on sight - restyled to the redesign's token system (step 3), same PrefsRepository state and gating as step 2. */
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
        item { CGPageTitle("Rules") }
        item { CGSub("How hard ContentGuard blocks, and what it blocks on sight.") }

        item { CGEyebrow("Blocking strength") }

        item {
            CGCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    CGLabel("NSFW threshold")
                    CGGateChip("raising")
                }
                CGHint("Confidence needed before a screen is blocked. Lower catches more, with a few more false stops.")
                Slider(
                    value = threshold,
                    onValueChange = { threshold = it },
                    onValueChangeFinished = {
                        val newValue = threshold
                        val oldValue = prefs.nsfwThreshold
                        // Lower threshold blocks more (score < threshold passes
                        // as safe) - raising it is the weakening move.
                        applyOrChallenge(newValue > oldValue, { threshold = oldValue }) {
                            prefs.nsfwThreshold = newValue
                        }
                    },
                    valueRange = 0f..1f,
                    colors = SliderDefaults.colors(thumbColor = CGColor.Guard, activeTrackColor = CGColor.Guard, inactiveTrackColor = CGColor.Raise),
                    modifier = Modifier.padding(top = 12.dp),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    EndLabel("0.00 · aggressive")
                    EndLabel(formatThreshold(threshold))
                }
            }
        }

        item {
            CGCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    CGLabel("Capture interval")
                    CGVal("${captureThrottleMs} ms")
                }
                CGHint(
                    "Minimum gap between screen checks while a monitored app is open. The static-content " +
                        "recheck trails ${PrefsRepository.STATIC_RECHECK_MARGIN_MS} ms behind it.",
                )
                Slider(
                    value = captureThrottleMs.toFloat(),
                    onValueChange = { captureThrottleMs = it.toLong() },
                    onValueChangeFinished = {
                        val newValue = captureThrottleMs
                        val oldValue = prefs.captureThrottleMs
                        // Lower cadence = faster/more frequent capture = stricter.
                        applyOrChallenge(newValue > oldValue, { captureThrottleMs = oldValue }) {
                            prefs.captureThrottleMs = newValue
                        }
                    },
                    valueRange = PrefsRepository.MIN_CAPTURE_THROTTLE_MS.toFloat()..PrefsRepository.MAX_CAPTURE_THROTTLE_MS.toFloat(),
                    colors = SliderDefaults.colors(thumbColor = CGColor.Guard, activeTrackColor = CGColor.Guard, inactiveTrackColor = CGColor.Raise),
                    modifier = Modifier.padding(top = 12.dp),
                )
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    EndLabel("Faster detection")
                    EndLabel("Better battery")
                }
            }
        }

        item { CGEyebrow("Blocked on sight") }

        item {
            CGCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CGLabel("Search terms")
                        Spacer(modifier = Modifier.width(6.dp))
                        CGVal("· ${explicitKeywords.size}")
                    }
                    CGGateChip("removing")
                }
                CGHint(
                    "A browser is blocked the instant one of these is typed, before any page loads. " +
                        "Adding is free; removing needs your password.",
                )
                KeywordManager(
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
        }

        item {
            CGCard {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        CGLabel("Go back on block")
                        CGHint("Auto-dismisses the blocked screen instead of just covering it.", modifier = Modifier.padding(top = 2.dp))
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    CGToggle(
                        checked = dismissOnBlock,
                        // Not a strictness lever - doesn't change what gets
                        // blocked, only the UX after a block already happened.
                        onCheckedChange = { dismissOnBlock = it; prefs.dismissOnBlock = it },
                    )
                }
            }
        }

        item {
            CGCard {
                CGLabel("Repeat-strike lockout")
                CGHint("Several blocks for the same app in a short window locks that one app for a cooldown.")
                Row(modifier = Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Strikes before lockout", color = CGColor.Dim, fontSize = 13.sp, lineHeight = 19.sp)
                    CGVal("$strikesToLockout")
                }
                Slider(
                    value = strikesToLockout.toFloat(),
                    onValueChange = { strikesToLockout = it.toInt() },
                    onValueChangeFinished = {
                        val newValue = strikesToLockout
                        val oldValue = prefs.strikesToLockout
                        // Fewer strikes needed locks out sooner - stricter.
                        // Raising the count is the weakening move.
                        applyOrChallenge(newValue > oldValue, { strikesToLockout = oldValue }) {
                            prefs.strikesToLockout = newValue
                        }
                    },
                    valueRange = 1f..20f,
                    steps = 18,
                    colors = SliderDefaults.colors(thumbColor = CGColor.Guard, activeTrackColor = CGColor.Guard, inactiveTrackColor = CGColor.Raise),
                )
                Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Lockout length", color = CGColor.Dim, fontSize = 13.sp, lineHeight = 19.sp)
                    CGVal("$lockoutDurationMinutes min")
                }
                Slider(
                    value = lockoutDurationMinutes.toFloat(),
                    onValueChange = { lockoutDurationMinutes = it.toInt() },
                    onValueChangeFinished = {
                        val newValue = lockoutDurationMinutes
                        val oldValue = prefs.lockoutDurationMinutes
                        // Longer lockout is stricter - shortening it is the
                        // weakening move.
                        applyOrChallenge(newValue < oldValue, { lockoutDurationMinutes = oldValue }) {
                            prefs.lockoutDurationMinutes = newValue
                        }
                    },
                    valueRange = 1f..30f,
                    steps = 28,
                    colors = SliderDefaults.colors(thumbColor = CGColor.Guard, activeTrackColor = CGColor.Guard, inactiveTrackColor = CGColor.Raise),
                )
                var whyOpen by remember { mutableStateOf(false) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 11.dp)
                        .clickable { whyOpen = !whyOpen },
                ) {
                    Text(
                        if (whyOpen) "⌄ How the window works" else "› How the window works",
                        color = CGColor.Dim,
                        fontFamily = JetBrainsMono,
                        fontSize = 12.5.sp,
                    )
                }
                if (whyOpen) {
                    Text(
                        "$strikesToLockout explicit-content blocks for the same app within 15 minutes " +
                            "locks just that app for the length above. Switching back into it re-shows the block.",
                        color = CGColor.Dim,
                        fontSize = 13.sp,
                        lineHeight = 19.5.sp,
                        modifier = Modifier.padding(top = 9.dp),
                    )
                }
                if (activeLockouts.isNotEmpty()) {
                    Row(modifier = Modifier.fillMaxWidth().padding(top = 11.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("Currently locked out", color = CGColor.Dim, fontSize = 12.5.sp)
                        CGButton("Refresh", onClick = { activeLockouts = prefs.getActiveLockouts() }, ghost = true, small = true)
                    }
                    val now = System.currentTimeMillis()
                    activeLockouts.forEach { (pkg, until) ->
                        val remainingSec = ((until - now) / 1000).coerceAtLeast(0)
                        Text("$pkg - ${remainingSec}s left", color = CGColor.Dim, fontSize = 12.5.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun EndLabel(text: String) {
    Text(text, color = CGColor.Faint, fontFamily = JetBrainsMono, fontSize = 11.5.sp)
}

/** Lower catches more (aggressive) - matches the prototype's fmt.thresh JS exactly, just in Kotlin over a 0f..1f value instead of 0..100. */
private fun formatThreshold(threshold: Float): String {
    val word = when {
        threshold >= 0.9f -> "strict"
        threshold <= 0.25f -> "aggressive"
        threshold <= 0.55f -> "lenient"
        else -> "balanced"
    }
    return "%.2f · %s".format(threshold, word)
}

@Composable
private fun KeywordManager(
    keywords: Set<String>,
    customized: Boolean,
    onAdd: (String) -> Unit,
    onRemove: (String) -> Unit,
    onResetToDefault: () -> Unit,
) {
    var newKeyword by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }

    if (customized) {
        Text("Customized - no longer the built-in default list.", color = CGColor.Dim, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
        OutlinedTextField(
            value = newKeyword,
            onValueChange = { newKeyword = it },
            label = { Text("Add term") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
            modifier = Modifier.weight(1f),
        )
        Spacer(modifier = Modifier.width(8.dp))
        CGButton("Add", onClick = {
            if (newKeyword.isNotBlank()) {
                onAdd(newKeyword)
                newKeyword = ""
            }
        }, small = true)
    }
    Row(modifier = Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(
            "${keywords.size} terms · built-in default has ${KeywordBlocklist.EXPLICIT_KEYWORDS.size}",
            color = CGColor.Dim,
            fontSize = 12.5.sp,
            modifier = Modifier.clickable { expanded = !expanded },
        )
        CGButton("Manage list", onClick = { expanded = !expanded }, ghost = true, small = true)
    }
    if (expanded) {
        CGButton("Reset to default", onClick = onResetToDefault, ghost = true, small = true, enabled = customized, modifier = Modifier.padding(top = 10.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp)
                .heightIn(max = 260.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            keywords.sorted().forEach { keyword ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(keyword, color = CGColor.Dim, fontFamily = JetBrainsMono, fontSize = 12.sp)
                    Text(
                        "Remove",
                        color = CGColor.Breach,
                        fontSize = 12.5.sp,
                        modifier = Modifier.clickable { onRemove(keyword) },
                    )
                }
            }
        }
    }
}
