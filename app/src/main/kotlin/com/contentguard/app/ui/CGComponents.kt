package com.contentguard.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.contentguard.app.scope.PrefsRepository
import com.contentguard.app.ui.theme.CGColor
import com.contentguard.app.ui.theme.JetBrainsMono

/**
 * Presentation primitives translated 1:1 from the redesign prototype's CSS
 * classes (contentguard-redesign.html) - one composable per class, same
 * tokens, same measurements. Kept purely visual: none of these carry any
 * PrefsRepository or gating logic - callers pass in state/callbacks from
 * the tabs, which still own all of that (see step 2).
 */

val CGCardShape: Shape = RoundedCornerShape(18.dp)

/**
 * `.card` - the ~18px-radius surface every settings group sits in.
 * Carries its own `margin-bottom:14px` (as trailing space the background
 * doesn't fill, applied before the background/border so it doesn't get
 * painted over) so consecutive cards in a LazyColumn aren't left touching
 * with nothing but their own 1dp border between them.
 */
@Composable
fun CGCard(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(18.dp),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 14.dp)
            .background(CGColor.Surface, CGCardShape)
            .border(1.dp, CGColor.Line, CGCardShape)
            .padding(padding),
        content = content,
    )
}

/** `.card.tight` - denser padding, used for the pillar list and the app-row list. */
val CGCardTightPadding = PaddingValues(horizontal = 16.dp, vertical = 15.dp)

/** `h1.page` - the big per-tab title ("Rules", "Apps", ...). */
@Composable
fun CGPageTitle(text: String) {
    Text(
        text,
        color = CGColor.Ink,
        fontSize = 26.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.02).em,
        modifier = Modifier.padding(start = 2.dp, end = 2.dp, top = 14.dp, bottom = 2.dp),
    )
}

/** `.sub` - the one-line explainer under a page title. */
@Composable
fun CGSub(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = CGColor.Dim,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        modifier = modifier.padding(start = 2.dp, end = 2.dp, top = 2.dp, bottom = 16.dp),
    )
}

/** `.sub` variant for callers that need part of the line emphasized (e.g. Apps' bold `<b>` lead-in), same type/spacing otherwise. */
@Composable
fun CGSub(text: AnnotatedString, modifier: Modifier = Modifier) {
    Text(
        text,
        color = CGColor.Dim,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        modifier = modifier.padding(start = 2.dp, end = 2.dp, top = 2.dp, bottom = 16.dp),
    )
}

/** `.label` - a card's primary heading text. */
@Composable
fun CGLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, color = CGColor.Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = modifier)
}

/** `.hint` - the smaller explainer line under a label. */
@Composable
fun CGHint(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        color = CGColor.Dim,
        fontSize = 13.sp,
        lineHeight = 19.sp,
        modifier = modifier.padding(top = 4.dp),
    )
}

/** `.val` - a mono-styled value/count, e.g. "3952 ms" or "· 47". */
@Composable
fun CGVal(text: String, modifier: Modifier = Modifier) {
    Text(text, color = CGColor.Guard, fontFamily = JetBrainsMono, fontSize = 14.sp, fontWeight = FontWeight.Medium, modifier = modifier)
}

/**
 * `.gate` - the small pill next to a control that names which direction
 * needs the password ("raising", "removing", "allowed"). Purely a static
 * label here - the actual password challenge is the existing
 * WeakenConfirmDialog/applyOrChallenge from step 2, not the prototype's
 * demo tap-to-reveal hint bubble (which stands in for a real dialog the
 * prototype doesn't have).
 */
@Composable
fun CGGateChip(text: String, modifier: Modifier = Modifier, showLockIcon: Boolean = true) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = modifier
            .background(CGColor.AttentionSoft, RoundedCornerShape(20.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        if (showLockIcon) {
            Box(
                modifier = Modifier
                    .size(9.dp)
                    .border(1.3.dp, CGColor.Attention, RoundedCornerShape(2.dp)),
            )
        }
        Text(
            text,
            color = CGColor.Attention,
            fontFamily = JetBrainsMono,
            fontSize = 10.5.sp,
            letterSpacing = 0.03.em,
        )
    }
}

/** `.btn` / `.btn.ghost` / `.btn.sm` - the pill button used throughout. */
@Composable
fun CGButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    ghost: Boolean = false,
    small: Boolean = false,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(50)
    val bg = if (ghost) CGColor.Bg.copy(alpha = 0f) else CGColor.Guard
    val fg = if (ghost) CGColor.Guard else CGColor.OnGuard
    val contentAlpha = if (enabled) 1f else 0.4f
    Box(
        modifier = modifier
            .clip(shape)
            .background(bg.copy(alpha = bg.alpha * contentAlpha))
            .let { if (ghost) it.border(1.dp, CGColor.Line2, shape) else it }
            .clickable(enabled = enabled, onClick = onClick)
            .padding(
                horizontal = if (small) 14.dp else 18.dp,
                vertical = if (small) 8.dp else 11.dp,
            ),
    ) {
        Text(
            text,
            color = fg.copy(alpha = contentAlpha),
            fontSize = if (small) 13.sp else 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * The (weakening, onCancelled, pendingAction, apply) shape of the app's one
 * asymmetric password gate - see ContentGuardApp.applyOrChallenge.
 * [pendingAction] is a serializable descriptor of what [apply] actually
 * does, used only when delay-before-unlock is on (see
 * PrefsRepository.PendingWeakenAction) - null for actions that have nothing
 * persistable to defer, like the two OS-navigation gates below.
 */
typealias GateChallenge = (
    weakening: Boolean,
    onCancelled: () -> Unit,
    pendingAction: PrefsRepository.PendingWeakenAction?,
    apply: () -> Unit,
) -> Unit

/**
 * A CGButton wired straight into the app's one password gate - the
 * redesign's "lock rule": password required to weaken protection or reach
 * a system Accessibility/Device-admin screen, never to tighten or view.
 * Every gated button in the app is always the weakening direction when
 * tapped (there's no "tightening" button-press, only slider/toggle moves
 * for those), so this just saves each call site repeating
 * `onClick = { applyOrChallenge(true, {}, null, action) }`.
 *
 * Always passes pendingAction = null: both call sites (opening the
 * accessibility/device-admin settings screens) launch an OS screen rather
 * than change any of ContentGuard's own state, so delay-before-unlock has
 * nothing to defer here - these stay instant-on-password regardless of
 * that setting.
 */
@Composable
fun CGGatedButton(
    text: String,
    applyOrChallenge: GateChallenge,
    onConfirmed: () -> Unit,
    modifier: Modifier = Modifier,
    ghost: Boolean = false,
    small: Boolean = false,
) {
    CGButton(text, onClick = { applyOrChallenge(true, {}, null, onConfirmed) }, modifier = modifier, ghost = ghost, small = small)
}

/** `.tog` - the pill switch, standing in for M3's Switch to match the prototype's track/thumb sizing exactly. */
@Composable
fun CGToggle(checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(50)
    Box(
        modifier = modifier
            .size(width = 46.dp, height = 27.dp)
            .clip(shape)
            .background(if (checked) CGColor.Guard else CGColor.Raise)
            .let { if (!checked) it.border(1.dp, CGColor.Line, shape) else it }
            // toggleable (not plain clickable) so TalkBack gets a real
            // Switch role and announces the on/off state itself.
            .toggleable(value = checked, onValueChange = onCheckedChange, role = Role.Switch)
            .padding(2.dp),
    ) {
        Box(
            modifier = Modifier
                .align(if (checked) Alignment.CenterEnd else Alignment.CenterStart)
                .size(21.dp)
                .background(if (checked) CGColor.OnGuard else CGColor.Dim, CircleShape),
        )
    }
}

/** `.seg` - the two-way segmented control (Apps tab's scope mode). */
@Composable
fun CGSegmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(CGColor.Surface2, RoundedCornerShape(13.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEachIndexed { index, label ->
            val isOn = index == selectedIndex
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (isOn) CGColor.Guard else CGColor.Bg.copy(alpha = 0f))
                    // selectable, not plain clickable, so TalkBack
                    // announces which option is currently selected.
                    .selectable(selected = isOn, onClick = { onSelect(index) }, role = Role.Tab)
                    .padding(vertical = 10.dp, horizontal = 8.dp),
            ) {
                Text(
                    label,
                    color = if (isOn) CGColor.OnGuard else CGColor.Dim,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** `.chip` - a single filter chip in the horizontally-scrolling `.chips` row. */
@Composable
fun CGChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier = modifier
            .clip(shape)
            .background(if (selected) CGColor.GuardSoft else CGColor.Surface)
            .let { if (!selected) it.border(1.dp, CGColor.Line, shape) else it }
            .selectable(selected = selected, onClick = onClick, role = Role.Tab)
            .padding(horizontal = 13.dp, vertical = 7.dp),
    ) {
        Text(
            text,
            color = if (selected) CGColor.Guard else CGColor.Dim,
            fontFamily = JetBrainsMono,
            fontSize = 12.sp,
        )
    }
}

/** One `.metric` cell inside a `.metrics` grid - caller builds the grid (2 or 3 columns) with a Row of these. */
@Composable
fun RowScope.CGMetric(number: String, unit: String?, kicker: String, quiet: Boolean = false, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .weight(1f)
            .background(CGColor.Surface)
            .padding(horizontal = 16.dp, vertical = 15.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                number,
                color = if (quiet) CGColor.Guard else CGColor.Ink,
                fontFamily = JetBrainsMono,
                fontSize = 24.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.02).em,
            )
            if (unit != null) {
                Text(unit, color = CGColor.Dim, fontFamily = JetBrainsMono, fontSize = 14.sp)
            }
        }
        Text(kicker, color = CGColor.Dim, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
    }
}

/**
 * `.metrics` grid wrapper - 1px hairline gutters between cells. `shape`
 * defaults to all four corners rounded (a single-row grid); pass a
 * corner-specific shape (e.g. top-only for the first of several stacked
 * rows) so a multi-row grid clips as one continuous card instead of a
 * stack of individually-rounded rows.
 */
@Composable
fun CGMetricsRow(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(14.dp), content: @Composable RowScope.() -> Unit) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(CGColor.Line),
        horizontalArrangement = Arrangement.spacedBy(1.dp),
        content = content,
    )
}
