package com.contentguard.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = GuardTeal,
    onPrimary = GuardBackgroundLight,
    secondary = GuardTealDark,
    background = GuardBackgroundLight,
    surface = GuardBackgroundLight,
    onBackground = GuardInk,
    onSurface = GuardInk,
)

private val DarkColors = darkColorScheme(
    primary = GuardTeal,
    onPrimary = GuardInk,
    secondary = GuardTealDark,
    background = GuardBackgroundDark,
    surface = GuardBackgroundDark,
)

@Composable
fun ContentGuardTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, content = content)
}
