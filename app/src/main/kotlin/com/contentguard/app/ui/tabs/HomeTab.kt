package com.contentguard.app.ui.tabs

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.CGBottomNavClearance
import com.contentguard.app.ui.CGCardShape
import com.contentguard.app.ui.CGCardTightPadding
import com.contentguard.app.ui.CGEyebrow
import com.contentguard.app.ui.CGMetric
import com.contentguard.app.ui.CGMetricsRow
import com.contentguard.app.ui.SafeguardState
import com.contentguard.app.ui.theme.CGColor
import com.contentguard.app.ui.theme.JetBrainsMono

/**
 * The safeguard seal - this and the Security tab's toggles are the two
 * places [SafeguardState] (built once in ContentGuardApp) actually shows
 * up. The seal's glow/verdict/pips/checkmark and the pillar list below it
 * all read the same three booleans off the one object passed in, so they
 * can never disagree about whether protection currently has a gap.
 */
@Composable
fun HomeTab(prefs: PrefsRepository, safeguards: SafeguardState) {
    var usageStats by remember { mutableStateOf(prefs.getUsageStats()) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp),
        contentPadding = CGBottomNavClearance,
    ) {
        if (!safeguards.allActive) {
            item { AttentionBanner(safeguards) }
        }

        item { Seal(safeguards) }

        item { CGEyebrow("Safeguards") }
        item { PillarsCard(safeguards) }

        item { CGEyebrow("Today") }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                CGMetricsRow(shape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)) {
                    CGMetric(number = "${usageStats.blockCount}", unit = null, kicker = "Blocks triggered", quiet = true)
                    CGMetric(number = "${usageStats.screenshotCount}", unit = null, kicker = "Screens checked")
                }
                CGMetricsRow(shape = RoundedCornerShape(bottomStart = 14.dp, bottomEnd = 14.dp)) {
                    CGMetric(number = "${usageStats.inferenceCount}", unit = null, kicker = "Classifier runs")
                    CGMetric(number = "%.0f".format(usageStats.avgInferenceMs), unit = "ms", kicker = "Avg latency")
                }
            }
        }
    }
}

@Composable
private fun AttentionBanner(safeguards: SafeguardState) {
    val down = downList(safeguards)
    val shape = RoundedCornerShape(14.dp)
    Row(
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 14.dp)
            .background(CGColor.BreachSoft, shape)
            .border(1.dp, CGColor.BreachBorder, shape)
            .padding(horizontal = 14.dp, vertical = 13.dp),
    ) {
        Text("⚠", fontSize = 16.sp)
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = CGColor.Ink, fontWeight = FontWeight.SemiBold)) {
                    append("Turn ${humanList(down)} back on.")
                }
                append(" ContentGuard can't fully protect you until every safeguard is active.")
            },
            color = CGColor.Dim,
            fontSize = 13.5.sp,
            lineHeight = 18.9.sp,
        )
    }
}

private fun downList(safeguards: SafeguardState): List<String> = buildList {
    if (!safeguards.accessibilityEnabled) add("screen watching")
    if (!safeguards.deviceAdminActive) add("the uninstall lock")
    if (!safeguards.batteryOptimizationIgnored) add("always-running")
}

private fun humanList(items: List<String>): String = when {
    items.isEmpty() -> ""
    items.size == 1 -> items.first()
    else -> items.dropLast(1).joinToString(", ") + " and " + items.last()
}

@Composable
private fun Seal(safeguards: SafeguardState) {
    val allActive = safeguards.allActive
    val mainColor = if (allActive) CGColor.Guard else CGColor.Breach
    val glowColor = if (allActive) CGColor.GuardSoft else CGColor.BreachSoft

    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth().padding(top = 26.dp, bottom = 8.dp)) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(160.dp)) {
            // `.glow` - a soft radial wash behind the shield. The
            // prototype also blurs this 8px; Compose has no simple
            // portable blur here, so this is a plain gradient instead -
            // a visual nicety, not load-bearing for the interaction.
            Box(
                modifier = Modifier
                    .size(150.dp)
                    .background(Brush.radialGradient(listOf(glowColor, glowColor.copy(alpha = 0f)))),
            )
            Canvas(modifier = Modifier.size(width = 118.dp, height = 132.dp)) {
                val sx = size.width / 118f
                val sy = size.height / 132f
                fun pt(x: Float, y: Float) = Offset(x * sx, y * sy)

                val shieldPath = Path().apply {
                    moveTo(pt(59f, 4f).x, pt(59f, 4f).y)
                    lineTo(pt(110f, 22f).x, pt(110f, 22f).y)
                    lineTo(pt(110f, 64f).x, pt(110f, 64f).y)
                    cubicTo(
                        pt(110f, 96f).x, pt(110f, 96f).y,
                        pt(88f, 116f).x, pt(88f, 116f).y,
                        pt(59f, 128f).x, pt(59f, 128f).y,
                    )
                    cubicTo(
                        pt(30f, 116f).x, pt(30f, 116f).y,
                        pt(8f, 96f).x, pt(8f, 96f).y,
                        pt(8f, 64f).x, pt(8f, 64f).y,
                    )
                    lineTo(pt(8f, 22f).x, pt(8f, 22f).y)
                    close()
                }

                drawPath(
                    shieldPath,
                    brush = Brush.verticalGradient(listOf(mainColor.copy(alpha = 0.22f), mainColor.copy(alpha = 0f))),
                )
                drawPath(
                    shieldPath,
                    color = mainColor,
                    style = Stroke(width = 2.4f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )

                val pipRadius = 5.5f * sx
                drawCircle(color = if (safeguards.accessibilityEnabled) CGColor.Guard else CGColor.Breach, radius = pipRadius, center = pt(59f, 46f))
                drawCircle(color = if (safeguards.deviceAdminActive) CGColor.Guard else CGColor.Breach, radius = pipRadius, center = pt(45f, 70f))
                drawCircle(color = if (safeguards.batteryOptimizationIgnored) CGColor.Guard else CGColor.Breach, radius = pipRadius, center = pt(73f, 70f))

                if (allActive) {
                    val checkPath = Path().apply {
                        moveTo(pt(46f, 88f).x, pt(46f, 88f).y)
                        lineTo(pt(55f, 97f).x, pt(55f, 97f).y)
                        lineTo(pt(74f, 76f).x, pt(74f, 76f).y)
                    }
                    drawPath(checkPath, color = mainColor, style = Stroke(width = 3.4f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round))
                }
            }
        }

        val down = downList(safeguards)
        Text(
            if (allActive) "You're protected" else "Protection has a gap",
            color = if (allActive) CGColor.Ink else CGColor.Breach,
            fontSize = 24.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = (-0.02).em,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 16.dp),
        )
        Text(
            if (allActive) {
                "All three safeguards are active"
            } else {
                "${humanList(down).replaceFirstChar { it.uppercase() }} ${if (down.size > 1) "are" else "is"} off"
            },
            color = CGColor.Dim,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 3.dp),
        )
    }
}

@Composable
private fun PillarsCard(safeguards: SafeguardState) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(CGColor.Surface, CGCardShape)
            .border(1.dp, CGColor.Line, CGCardShape)
            .padding(CGCardTightPadding),
    ) {
        Pillar(title = "Screen watching", description = "Accessibility service running", on = safeguards.accessibilityEnabled, showDivider = true)
        Pillar(title = "Uninstall lock", description = "Device admin holding", on = safeguards.deviceAdminActive, showDivider = true)
        Pillar(title = "Always running", description = "Exempt from battery limits", on = safeguards.batteryOptimizationIgnored, showDivider = false)
    }
}

@Composable
private fun Pillar(title: String, description: String, on: Boolean, showDivider: Boolean) {
    val color = if (on) CGColor.Guard else CGColor.Breach
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 14.dp)
            .then(if (showDivider) Modifier.bottomHairline() else Modifier),
    ) {
        // `.dot`'s box-shadow spreads a soft halo *outward* around the
        // 9px core - a Compose border would instead draw inward and
        // shrink the visible dot, so this is two nested circles (halo,
        // then the solid core on top) rather than one bordered one.
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(17.dp)) {
            Box(modifier = Modifier.size(17.dp).background(color.copy(alpha = 0.14f), CircleShape))
            Box(modifier = Modifier.size(9.dp).background(color, CircleShape))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = CGColor.Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(description, color = CGColor.Dim, fontSize = 12.5.sp, modifier = Modifier.padding(top = 1.dp))
        }
        Text(
            if (on) "ACTIVE" else "OFF",
            color = color,
            fontFamily = JetBrainsMono,
            fontSize = 12.sp,
            letterSpacing = 0.04.em,
        )
    }
}

private fun Modifier.bottomHairline(): Modifier = drawBehind {
    drawLine(
        color = CGColor.Line,
        start = Offset(0f, size.height),
        end = Offset(size.width, size.height),
        strokeWidth = 1.dp.toPx(),
    )
}
