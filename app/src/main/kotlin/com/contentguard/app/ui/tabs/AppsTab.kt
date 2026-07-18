package com.contentguard.app.ui.tabs

import android.content.Context
import android.content.Intent
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.scope.ScopeMode
import com.contentguard.app.ui.CGAppTitleRow
import com.contentguard.app.ui.CGBottomNavClearance
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class AppEntry(
    val packageName: String,
    val label: String,
    val icon: ImageBitmap?,
    // No launcher/home icon - a background service, OEM system app, etc.
    // that a user could never find or whitelist before QUERY_ALL_PACKAGES
    // was added specifically to surface these.
    val hidden: Boolean,
    // Called out specifically, not just lumped into "hidden" - see
    // ContentGuardService.recheckStaticContent's IME-window comment for why
    // an input method's own window can end up monitored from typing alone,
    // with no app ever opened.
    val isInputMethod: Boolean,
)

/** Step 1 placeholder - scope mode, filter chips, search, per-app rows land here in step 2. */
@Composable
fun AppsTab(prefs: PrefsRepository, applyOrChallenge: (weakening: Boolean, onCancelled: () -> Unit, apply: () -> Unit) -> Unit) {
    val context = LocalContext.current

    var mode by remember { mutableStateOf(prefs.mode) }
    var whitelist by remember { mutableStateOf(prefs.getWhitelist()) }
    var monitored by remember { mutableStateOf(prefs.getMonitoredSet()) }
    var apps by remember { mutableStateOf(emptyList<AppEntry>()) }
    // Collapsed by default - with every installed package on the device
    // rendered as its own row (not just launchable ones, now that hidden/
    // system packages and input methods are included too), this list alone
    // made the Settings screen a very long single page. Collapsed, it's
    // just a one-line summary.
    var appsExpanded by remember { mutableStateOf(false) }
    // A flat list of every installed package can run into the hundreds
    // once hidden/system packages are included - without this, finding one
    // specific package (an input method, say) would mean scrolling through
    // all of them.
    var appSearchQuery by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        apps = withContext(Dispatchers.Default) { loadLaunchableApps(context) }
    }

    fun isMonitored(pkg: String): Boolean = when (mode) {
        ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST -> pkg !in whitelist
        ScopeMode.MONITOR_ONLY_LISTED -> pkg in monitored
    }

    fun setMonitored(pkg: String, monitor: Boolean) {
        // Turning monitoring OFF for an app is the weakening direction
        // regardless of scope mode (it always means "watch this app
        // less"); turning it ON is hardening and applies immediately.
        applyOrChallenge(!monitor, {}) {
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
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGAppTitleRow() }

        item {
            ScopeModeSection(
                mode = mode,
                onModeChange = { newMode ->
                    // MONITOR_ONLY_LISTED is the weakening direction - it
                    // defaults to *not* watching anything unless explicitly
                    // listed, versus MONITOR_ALL_EXCEPT_WHITELIST's broader
                    // default coverage.
                    applyOrChallenge(newMode == ScopeMode.MONITOR_ONLY_LISTED, {}) {
                        mode = newMode
                        prefs.mode = newMode
                    }
                },
            )
        }

        item {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { appsExpanded = !appsExpanded }
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = "Apps (${apps.size})", style = MaterialTheme.typography.titleMedium)
                Text(if (appsExpanded) "▾ Hide" else "▸ Show", style = MaterialTheme.typography.bodyMedium)
            }
        }

        if (appsExpanded) {
            item {
                Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    OutlinedTextField(
                        value = appSearchQuery,
                        onValueChange = { appSearchQuery = it },
                        label = { Text("Search apps") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
            }

            val filteredApps = if (appSearchQuery.isBlank()) {
                apps
            } else {
                apps.filter {
                    it.label.contains(appSearchQuery, ignoreCase = true) ||
                        it.packageName.contains(appSearchQuery, ignoreCase = true)
                }
            }
            items(filteredApps, key = { it.packageName }) { app ->
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
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label)
    }
}

@Composable
private fun AppRow(app: AppEntry, monitored: Boolean, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (app.icon != null) {
                Image(bitmap = app.icon, contentDescription = null, modifier = Modifier.size(32.dp))
                Spacer(modifier = Modifier.width(8.dp))
            }
            Column {
                Text(app.label)
                val tag = when {
                    app.isInputMethod -> "Input method · ${app.packageName}"
                    app.hidden -> "Hidden · ${app.packageName}"
                    else -> null
                }
                if (tag != null) {
                    Text(
                        tag,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Switch(checked = monitored, onCheckedChange = onToggle)
    }
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
    val launchablePackages = (pm.queryIntentActivities(launcherIntent, 0) + pm.queryIntentActivities(homeIntent, 0))
        .map { it.activityInfo.packageName }
        .toSet()

    // Called out specifically (not just left to fall out of the full
    // package list below as "hidden") since an input method's own window
    // is the concrete, real-device-confirmed case of a package with no
    // launcher icon that can still end up monitored - see
    // ContentGuardService.recheckStaticContent's IME-window comment.
    val inputMethodPackages = (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
        .inputMethodList
        .map { it.packageName }
        .toSet()

    // Every installed package, not just launchable ones - background
    // services and other OEM system apps could never be found or
    // whitelisted before, even though they're just as monitorable as any
    // launchable app under "Monitor all except whitelisted". Requires
    // QUERY_ALL_PACKAGES (see AndroidManifest.xml for why that's safe here).
    return pm.getInstalledApplications(0)
        .filter { it.packageName != context.packageName }
        .map { info ->
            val icon = runCatching { info.loadIcon(pm).toBitmap(96, 96).asImageBitmap() }.getOrNull()
            val label = runCatching { pm.getApplicationLabel(info).toString() }.getOrDefault(info.packageName)
            AppEntry(
                packageName = info.packageName,
                label = label,
                icon = icon,
                hidden = info.packageName !in launchablePackages,
                isInputMethod = info.packageName in inputMethodPackages,
            )
        }
        .sortedBy { it.label.lowercase() }
}
