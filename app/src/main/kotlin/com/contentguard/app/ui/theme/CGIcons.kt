package com.contentguard.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * Bottom-nav icons, translated stroke-for-stroke from the prototype's
 * inline SVGs (24x24 viewBox, 1.8 stroke width, round caps/joins) rather
 * than substituted with stock Material icons - the prototype is the
 * source of truth for the two signature interactions and the overall
 * look, and these five glyphs are as much a part of that as the color
 * tokens. Colored via Icon()'s tint parameter at the call site, not
 * baked in here - the stroke/fill color below is a placeholder any solid
 * opaque color would do the same job.
 */
private const val PLACEHOLDER_STROKE = 0xFF000000

private fun ImageVector.Builder.strokeShieldHome() {
    path(
        fill = null,
        stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
        strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) {
        moveTo(12f, 3f)
        lineTo(20f, 7f)
        verticalLineTo(12f)
        curveTo(20f, 17f, 16.5f, 20f, 12f, 21f)
        curveTo(7.5f, 20f, 4f, 17f, 4f, 12f)
        verticalLineTo(7f)
        lineTo(12f, 3f)
        close()
    }
    path(
        fill = null,
        stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
        strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    ) {
        moveTo(9f, 12f)
        lineTo(11f, 14f)
        lineTo(15f, 10f)
    }
}

private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
    moveTo(cx + r, cy)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = cx - r, y1 = cy)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = cx + r, y1 = cy)
    close()
}

private fun PathBuilder.roundedRect(x: Float, y: Float, w: Float, h: Float, r: Float) {
    moveTo(x + r, y)
    lineTo(x + w - r, y)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = x + w, y1 = y + r)
    lineTo(x + w, y + h - r)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = x + w - r, y1 = y + h)
    lineTo(x + r, y + h)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = x, y1 = y + h - r)
    lineTo(x, y + r)
    arcTo(r, r, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = x + r, y1 = y)
    close()
}

object CGIcons {

    val Home: ImageVector by lazy {
        ImageVector.Builder(
            name = "CGHome", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply { strokeShieldHome() }.build()
    }

    val Rules: ImageVector by lazy {
        ImageVector.Builder(
            name = "CGRules", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
            ) {
                moveTo(5f, 6f); lineTo(19f, 6f)
                moveTo(5f, 12f); lineTo(19f, 12f)
                moveTo(5f, 18f); lineTo(14f, 18f)
            }
            path(fill = SolidColor(Color(PLACEHOLDER_STROKE)), pathFillType = PathFillType.NonZero) {
                circle(16f, 6f, 2.2f)
            }
            path(fill = SolidColor(Color(PLACEHOLDER_STROKE)), pathFillType = PathFillType.NonZero) {
                circle(9f, 12f, 2.2f)
            }
        }.build()
    }

    val Apps: ImageVector by lazy {
        ImageVector.Builder(
            name = "CGApps", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            listOf(4f to 4f, 14f to 4f, 4f to 14f, 14f to 14f).forEach { (x, y) ->
                path(
                    fill = null,
                    stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
                    strokeLineWidth = 1.8f,
                ) {
                    roundedRect(x, y, 6f, 6f, 1.6f)
                }
            }
        }.build()
    }

    val Activity: ImageVector by lazy {
        ImageVector.Builder(
            name = "CGActivity", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
                strokeLineWidth = 1.8f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                moveTo(4f, 14f)
                lineTo(8f, 9f)
                lineTo(11f, 12f)
                lineTo(15f, 5f)
                lineTo(18f, 10f)
                lineTo(20f, 8f)
            }
        }.build()
    }

    val Security: ImageVector by lazy {
        ImageVector.Builder(
            name = "CGSecurity", defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            path(
                fill = null,
                stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
                strokeLineWidth = 1.8f,
            ) {
                roundedRect(5f, 11f, 14f, 9f, 2f)
            }
            path(
                fill = null,
                stroke = SolidColor(Color(PLACEHOLDER_STROKE)),
                strokeLineWidth = 1.8f,
            ) {
                moveTo(8f, 11f)
                verticalLineTo(8f)
                arcTo(4f, 4f, 0f, isMoreThanHalf = false, isPositiveArc = true, x1 = 16f, y1 = 8f)
                verticalLineTo(11f)
            }
        }.build()
    }
}
