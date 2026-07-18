package com.contentguard.app.ui

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.tabs.ActivityTab
import com.contentguard.app.ui.tabs.AppsTab
import com.contentguard.app.ui.tabs.HomeTab
import com.contentguard.app.ui.tabs.RulesTab
import com.contentguard.app.ui.tabs.SecurityTab
import com.contentguard.app.ui.theme.CGColor

/**
 * Root of the redesigned Settings UI - five-tab bottom nav over a single
 * content area, replacing the old single long-scroll SettingsScreen (see
 * SettingsActivity.kt; its composables stay in place, unreferenced, until
 * step 2 migrates their content into the tab files under ui/tabs/).
 *
 * Built as a plain Box overlay (content behind, nav bar on top) rather
 * than Scaffold's bottomBar slot, so the nav visually sits over the
 * scrolling content the way the prototype's absolutely-positioned `.nav`
 * does, instead of reserving its own non-overlapping strip. True
 * backdrop-blur (the prototype's `backdrop-filter:blur(14px)`) isn't
 * replicated - a semi-transparent fill stands in for it; not load-bearing
 * for either signature interaction, just a visual nicety left for later
 * polish.
 */
@Composable
fun ContentGuardApp(prefs: PrefsRepository) {
    var selected by remember { mutableStateOf(CGTab.HOME) }

    Box(modifier = Modifier.fillMaxSize().background(CGColor.Bg)) {
        Crossfade(targetState = selected, label = "tab") { tab ->
            when (tab) {
                CGTab.HOME -> HomeTab(prefs)
                CGTab.RULES -> RulesTab(prefs)
                CGTab.APPS -> AppsTab(prefs)
                CGTab.ACTIVITY -> ActivityTab(prefs)
                CGTab.SECURITY -> SecurityTab(prefs)
            }
        }

        CGBottomNav(
            selected = selected,
            onSelect = { selected = it },
            modifier = Modifier.align(Alignment.BottomCenter),
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
