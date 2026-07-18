package com.contentguard.app.ui.tabs

import android.content.Context
import android.content.Intent
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.scope.ScopeMode
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGCardShape
import com.contentguard.app.ui.CGChip
import com.contentguard.app.ui.CGPageTitle
import com.contentguard.app.ui.CGSegmented
import com.contentguard.app.ui.CGSub
import com.contentguard.app.ui.CGToggle
import com.contentguard.app.ui.GateChallenge
import com.contentguard.app.ui.theme.CGColor
import com.contentguard.app.ui.theme.JetBrainsMono
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

private enum class AppsFilter { ALL, MONITORED, ALLOWED, SYSTEM }

/** How ContentGuard scopes what it watches - restyled to the redesign's token system (step 3), same PrefsRepository state and gating as step 2. */
@Composable
fun AppsTab(prefs: PrefsRepository, applyOrChallenge: GateChallenge) {
    val context = LocalContext.current

    var mode by remember { mutableStateOf(prefs.mode) }
    var whitelist by remember { mutableStateOf(prefs.getWhitelist()) }
    var monitored by remember { mutableStateOf(prefs.getMonitoredSet()) }
    var apps by remember { mutableStateOf(emptyList<AppEntry>()) }
    var filter by remember { mutableStateOf(AppsFilter.ALL) }
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

    val monitoredCount = apps.count { isMonitored(it.packageName) }
    val filtered = apps
        .filter {
            when (filter) {
                AppsFilter.ALL -> true
                AppsFilter.MONITORED -> isMonitored(it.packageName)
                AppsFilter.ALLOWED -> !isMonitored(it.packageName)
                AppsFilter.SYSTEM -> it.hidden
            }
        }
        .filter {
            appSearchQuery.isBlank() ||
                it.label.contains(appSearchQuery, ignoreCase = true) ||
                it.packageName.contains(appSearchQuery, ignoreCase = true)
        }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        item { CGPageTitle("Apps") }
        item {
            CGSub(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = CGColor.Ink, fontWeight = FontWeight.Bold)) {
                        append("Monitoring $monitoredCount of ${apps.size} apps.")
                    }
                    append(" Allowing an app stops all checks inside it.")
                },
            )
        }

        item {
            CGSegmented(
                options = listOf("All except allowed", "Only listed"),
                selectedIndex = if (mode == ScopeMode.MONITOR_ONLY_LISTED) 1 else 0,
                onSelect = { index ->
                    val newMode = if (index == 1) ScopeMode.MONITOR_ONLY_LISTED else ScopeMode.MONITOR_ALL_EXCEPT_WHITELIST
                    // MONITOR_ONLY_LISTED is the weakening direction - it
                    // defaults to *not* watching anything unless explicitly
                    // listed, versus MONITOR_ALL_EXCEPT_WHITELIST's broader
                    // default coverage.
                    applyOrChallenge(newMode == ScopeMode.MONITOR_ONLY_LISTED, {}) {
                        mode = newMode
                        prefs.mode = newMode
                    }
                },
                modifier = Modifier.padding(bottom = 14.dp),
            )
        }

        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 12.dp)) {
                item {
                    CGChip("All · ${apps.size}", selected = filter == AppsFilter.ALL, onClick = { filter = AppsFilter.ALL })
                }
                item {
                    CGChip("Monitored · $monitoredCount", selected = filter == AppsFilter.MONITORED, onClick = { filter = AppsFilter.MONITORED })
                }
                item {
                    CGChip("Allowed · ${apps.size - monitoredCount}", selected = filter == AppsFilter.ALLOWED, onClick = { filter = AppsFilter.ALLOWED })
                }
                item {
                    CGChip("System", selected = filter == AppsFilter.SYSTEM, onClick = { filter = AppsFilter.SYSTEM })
                }
            }
        }

        item {
            OutlinedTextField(
                value = appSearchQuery,
                onValueChange = { appSearchQuery = it },
                placeholder = { Text("Search apps", color = CGColor.Faint) },
                singleLine = true,
                keyboardOptions = KeyboardOptions.Default,
                shape = RoundedCornerShape(13.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = CGColor.Surface,
                    unfocusedContainerColor = CGColor.Surface,
                    focusedIndicatorColor = CGColor.Line,
                    unfocusedIndicatorColor = CGColor.Line,
                ),
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            )
        }

        // items(), not a forEach inside one eager CGCard Column, so a
        // 500+-app device list stays lazily virtualized the same way it
        // was in step 2 - only the row's own background/corners fake the
        // single continuous card look CGCard would otherwise give it.
        itemsIndexed(filtered, key = { _, app -> app.packageName }) { index, app ->
            AppRow(
                app = app,
                monitored = isMonitored(app.packageName),
                onToggle = { setMonitored(app.packageName, it) },
                shape = when {
                    filtered.size == 1 -> CGCardShape
                    index == 0 -> RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)
                    index == filtered.lastIndex -> RoundedCornerShape(bottomStart = 18.dp, bottomEnd = 18.dp)
                    else -> RoundedCornerShape(0.dp)
                },
                showDivider = index != filtered.lastIndex,
            )
        }
    }
}

@Composable
private fun AppRow(app: AppEntry, monitored: Boolean, onToggle: (Boolean) -> Unit, shape: androidx.compose.ui.graphics.Shape, showDivider: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(CGColor.Surface, shape)
            .padding(horizontal = 16.dp, vertical = 13.dp)
            .then(
                if (showDivider) {
                    Modifier.drawBehind {
                        drawLine(
                            color = CGColor.Line,
                            start = androidx.compose.ui.geometry.Offset(0f, size.height),
                            end = androidx.compose.ui.geometry.Offset(size.width, size.height),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                } else {
                    Modifier
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        AppIcon(app)
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    app.label,
                    color = CGColor.Ink,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (!monitored) {
                    Spacer(modifier = Modifier.width(6.dp))
                    com.contentguard.app.ui.CGGateChip("allowed", showLockIcon = false)
                }
            }
            val tag = when {
                app.isInputMethod -> "Input method · ${app.packageName}"
                app.hidden -> "Hidden · ${app.packageName}"
                else -> app.packageName
            }
            Text(
                tag,
                color = CGColor.Faint,
                fontFamily = JetBrainsMono,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp),
            )
        }
        CGToggle(checked = monitored, onCheckedChange = onToggle)
    }
}

@Composable
private fun AppIcon(app: AppEntry) {
    val shape = RoundedCornerShape(11.dp)
    if (app.icon != null) {
        Image(
            bitmap = app.icon,
            contentDescription = null,
            modifier = Modifier.size(38.dp).background(CGColor.Raise, shape),
        )
    } else {
        Box(
            modifier = Modifier.size(38.dp).background(avatarColor(app.packageName), shape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                app.label.take(2).uppercase(),
                color = androidx.compose.ui.graphics.Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

private val AvatarPalette = listOf(
    androidx.compose.ui.graphics.Color(0xFF3B5BDB),
    androidx.compose.ui.graphics.Color(0xFFE8590C),
    androidx.compose.ui.graphics.Color(0xFF1971C2),
    androidx.compose.ui.graphics.Color(0xFF2F9E44),
    androidx.compose.ui.graphics.Color(0xFF495057),
    androidx.compose.ui.graphics.Color(0xFF9C36B5),
)

private fun avatarColor(packageName: String): androidx.compose.ui.graphics.Color =
    AvatarPalette[(packageName.hashCode().mod(AvatarPalette.size))]

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
