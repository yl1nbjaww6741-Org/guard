package com.contentguard.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Design tokens from the redesign prototype (contentguard-redesign.html) -
 * kept verbatim, not reinterpreted. The prototype is dark-only (no light
 * variant defined), so this is the app's fixed palette, not a dark branch
 * of an adaptive scheme.
 */
object CGColor {
    val Bg = Color(0xFF0D1210)
    val Surface = Color(0xFF141A18)
    val Surface2 = Color(0xFF1B2320)
    val Raise = Color(0xFF222B28)
    val Line = Color(0x12FFFFFF) // rgba(255,255,255,.07)
    val Line2 = Color(0x1CFFFFFF) // rgba(255,255,255,.11)
    val Ink = Color(0xFFEEF1EE)
    val Dim = Color(0xFF98A29D)
    val Faint = Color(0xFF606A65)

    val Guard = Color(0xFF41CBA6)
    val GuardSoft = Color(0x2441CBA6) // rgba(65,203,166,.14)
    val Attention = Color(0xFFE6B04C)
    val AttentionSoft = Color(0x21E6B04C) // rgba(230,176,76,.13)
    val AttentionBorder = Color(0x47E6B04C) // rgba(230,176,76,.28), banner border
    val Breach = Color(0xFFE37B70)
    val BreachSoft = Color(0x24E37B70) // rgba(227,123,112,.14)
    val BreachBorder = Color(0x4DE37B70) // rgba(227,123,112,.3), banner border

    /** Debug log's own background - distinct from, and darker than, Bg. */
    val LogBg = Color(0xFF0A0F0D)

    /** Text/icon color sitting on a solid Guard fill (primary buttons, checkmark hole). */
    val OnGuard = Color(0xFF06231C)
}
