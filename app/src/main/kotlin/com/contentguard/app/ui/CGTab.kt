package com.contentguard.app.ui

import androidx.compose.ui.graphics.vector.ImageVector
import com.contentguard.app.ui.theme.CGIcons

/** The five bottom-nav destinations - see the redesign prototype's information architecture table. */
enum class CGTab(val label: String, val icon: ImageVector) {
    HOME("Home", CGIcons.Home),
    RULES("Rules", CGIcons.Rules),
    APPS("Apps", CGIcons.Apps),
    ACTIVITY("Activity", CGIcons.Activity),
    SECURITY("Security", CGIcons.Security),
}
