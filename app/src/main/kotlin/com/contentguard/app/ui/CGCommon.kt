package com.contentguard.app.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Bottom content-padding every tab's LazyColumn needs so its last item
 * clears the overlaid bottom nav (see ContentGuardApp - the nav is a Box
 * overlay, not a Scaffold bottomBar reserving its own space, matching the
 * prototype's absolutely-positioned `.nav` over `.screen{padding-bottom:108px}`).
 */
val CGBottomNavClearance = PaddingValues(bottom = 108.dp)

/** Section eyebrow ("SAFEGUARDS", "TODAY", ...) - JetBrains Mono, uppercase, wide tracking, faint. Caller passes already-uppercased text. */
@Composable
fun CGEyebrow(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = com.contentguard.app.ui.theme.CGEyebrowStyle, modifier = modifier.padding(top = 20.dp, bottom = 10.dp, start = 2.dp))
}
