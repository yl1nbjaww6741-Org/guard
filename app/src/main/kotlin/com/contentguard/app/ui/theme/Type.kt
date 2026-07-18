package com.contentguard.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.contentguard.app.R

/**
 * Two font families, one job each, per the prototype: Hanken Grotesk for
 * everything a human reads as prose (headings, body, buttons); JetBrains
 * Mono for anything that's data (labels, package names, debug log, metric
 * numbers, section eyebrows). Bundled as static-weight TTFs (instanced
 * from Google Fonts' variable-font releases) rather than referencing the
 * variable font directly, for broad OEM/Android-version compatibility.
 */
val HankenGrotesk = FontFamily(
    Font(R.font.hanken_400, FontWeight.Normal),
    Font(R.font.hanken_500, FontWeight.Medium),
    Font(R.font.hanken_600, FontWeight.SemiBold),
    Font(R.font.hanken_700, FontWeight.Bold),
    Font(R.font.hanken_800, FontWeight.ExtraBold),
)

val JetBrainsMono = FontFamily(
    Font(R.font.jbmono_400, FontWeight.Normal),
    Font(R.font.jbmono_500, FontWeight.Medium),
    Font(R.font.jbmono_600, FontWeight.SemiBold),
)

/**
 * Section eyebrow style used above every card group ("SAFEGUARDS", "TODAY",
 * "BLOCKING STRENGTH", ...): ~11sp mono, uppercase, wide tracking, faint.
 * Callers supply the text already-uppercased (or use .uppercase() at the
 * call site) - this only carries type/color, not case transformation.
 */
val CGEyebrowStyle = TextStyle(
    fontFamily = JetBrainsMono,
    fontSize = 11.sp,
    fontWeight = FontWeight.Medium,
    letterSpacing = 0.18.em,
    color = CGColor.Faint,
)

/** Mono data style for package names, log lines, metric numbers, values - not size-fixed, override fontSize per use. */
val CGMonoStyle = TextStyle(fontFamily = JetBrainsMono)

val CGTypography = Typography().let { base ->
    Typography(
        displayLarge = base.displayLarge.copy(fontFamily = HankenGrotesk),
        displayMedium = base.displayMedium.copy(fontFamily = HankenGrotesk),
        displaySmall = base.displaySmall.copy(fontFamily = HankenGrotesk),
        headlineLarge = base.headlineLarge.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.ExtraBold),
        headlineMedium = base.headlineMedium.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.ExtraBold),
        headlineSmall = base.headlineSmall.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.ExtraBold),
        titleLarge = base.titleLarge.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.Bold),
        titleMedium = base.titleMedium.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.SemiBold),
        titleSmall = base.titleSmall.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.SemiBold),
        bodyLarge = base.bodyLarge.copy(fontFamily = HankenGrotesk),
        bodyMedium = base.bodyMedium.copy(fontFamily = HankenGrotesk),
        bodySmall = base.bodySmall.copy(fontFamily = HankenGrotesk),
        labelLarge = base.labelLarge.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.SemiBold),
        labelMedium = base.labelMedium.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.SemiBold),
        labelSmall = base.labelSmall.copy(fontFamily = HankenGrotesk, fontWeight = FontWeight.SemiBold),
    )
}
