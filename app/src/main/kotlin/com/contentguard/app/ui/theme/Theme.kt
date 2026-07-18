package com.contentguard.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

/**
 * Fixed dark scheme built from the redesign prototype's tokens - the
 * prototype defines no light variant, so unlike the previous adaptive
 * light/dark theme, this is the app's one look regardless of system
 * theme. Custom composables (cards, pills, the seal, nav) mostly reach
 * CGColor directly rather than through M3 role names, since the design's
 * semantic colors (guard/attention/breach) don't map cleanly onto M3's
 * primary/secondary/tertiary roles - this ColorScheme exists mainly so
 * stock M3 components used as-is (AlertDialog, Slider, Switch) still land
 * on the right palette instead of Compose's own defaults.
 */
private val CGColorScheme = darkColorScheme(
    background = CGColor.Bg,
    onBackground = CGColor.Ink,
    surface = CGColor.Surface,
    onSurface = CGColor.Ink,
    surfaceVariant = CGColor.Surface2,
    onSurfaceVariant = CGColor.Dim,
    primary = CGColor.Guard,
    onPrimary = CGColor.OnGuard,
    secondary = CGColor.Guard,
    onSecondary = CGColor.OnGuard,
    tertiary = CGColor.Attention,
    onTertiary = CGColor.Bg,
    error = CGColor.Breach,
    onError = CGColor.Ink,
    outline = CGColor.Line2,
    outlineVariant = CGColor.Line,
)

@Composable
fun ContentGuardTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = CGColorScheme, typography = CGTypography, content = content)
}
