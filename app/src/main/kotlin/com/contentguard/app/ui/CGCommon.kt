package com.contentguard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.contentguard.app.ui.theme.CGColor

/**
 * Bottom content-padding every tab's LazyColumn needs so its last item
 * clears the overlaid bottom nav (see ContentGuardApp - the nav is a Box
 * overlay, not a Scaffold bottomBar reserving its own space, matching the
 * prototype's absolutely-positioned `.nav` over `.screen{padding-bottom:108px}`).
 */
val CGBottomNavClearance = PaddingValues(bottom = 108.dp)

/**
 * The small "● ContentGuard" row at the top of every tab's scrollable
 * content (prototype's `.apptitle` - scrolls away with the rest of the
 * pane, not a pinned header). Each tab includes this as its own first
 * LazyColumn item rather than the app hosting one shared pinned header,
 * since panes differ enough in structure that a shared header composable
 * would need to reach into each one anyway.
 */
@Composable
fun CGAppTitleRow() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(start = 2.dp, top = 8.dp, bottom = 2.dp),
    ) {
        androidx.compose.foundation.layout.Box(
            modifier = Modifier
                .size(6.dp)
                .background(CGColor.Guard, CircleShape),
        )
        androidx.compose.foundation.layout.Spacer(modifier = Modifier.size(8.dp))
        Text(
            "ContentGuard",
            color = CGColor.Ink,
            fontWeight = MaterialTheme.typography.titleSmall.fontWeight,
            fontSize = 15.sp,
        )
    }
}

/** Section eyebrow ("SAFEGUARDS", "TODAY", ...) - JetBrains Mono, uppercase, wide tracking, faint. Caller passes already-uppercased text. */
@Composable
fun CGEyebrow(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = com.contentguard.app.ui.theme.CGEyebrowStyle, modifier = modifier.padding(top = 20.dp, bottom = 10.dp, start = 2.dp))
}
