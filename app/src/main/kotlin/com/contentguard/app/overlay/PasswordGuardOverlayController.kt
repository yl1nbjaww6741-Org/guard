package com.contentguard.app.overlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.contentguard.app.R

/**
 * Gates access to the system "Device admin apps" screen behind
 * ContentGuard's own password (see ContentGuardService's GATE_DEVICE_ADMIN_GUARD).
 * Without this, deactivating device admin from system Settings would undo
 * the force-stop/uninstall protection with zero friction. Same
 * TYPE_ACCESSIBILITY_OVERLAY mechanism as BlurOverlayController, but a real
 * password prompt rather than the fake-crash dialog.
 *
 * Supports a second display mode, the cooldown message, for
 * delay-before-unlock (see PrefsRepository.settingsGuardCooldownEligibleAtMillis):
 * a correct password doesn't always mean "grant access now" - if a cooldown
 * hasn't elapsed yet, [onUnlocked] calls back into [showCooldown] instead of
 * this controller hiding itself. Swapping the dialog's own content (rather
 * than hiding this overlay and hoping something else covers the screen in
 * time) means there's no frame where the real guarded screen is visible
 * with nothing blocking it.
 */
class PasswordGuardOverlayController(
    private val service: AccessibilityService,
    private val onVerify: (String) -> Boolean,
    private val onUnlocked: () -> Unit,
    private val onCancelled: () -> Unit,
) {

    private val windowManager: WindowManager =
        service.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private lateinit var input: EditText
    private lateinit var errorText: TextView
    private lateinit var formGroup: LinearLayout
    private lateinit var cooldownGroup: LinearLayout
    private lateinit var cooldownText: TextView
    private val overlayView: View by lazy { buildView() }
    private var isShowing = false

    /**
     * Must be called from the main thread. [initialCooldownMessage] lets a
     * caller who already knows a cooldown is pending (e.g. re-entering this
     * screen before an earlier one has elapsed) skip straight to that
     * display without asking for the password again - it's already been
     * proven correct once, to start this cooldown.
     */
    fun show(initialCooldownMessage: String? = null) {
        val view = overlayView // ensures buildView() ran first
        input.setText("")
        errorText.visibility = View.GONE
        if (initialCooldownMessage != null) {
            showCooldown(initialCooldownMessage)
        } else {
            showForm()
        }

        if (isShowing) return
        try {
            windowManager.addView(view, buildLayoutParams())
            isShowing = true
            if (initialCooldownMessage == null) {
                input.post {
                    input.requestFocus()
                    val imm = service.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                    imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to add password guard overlay", e)
        }
    }

    fun hide() {
        if (!isShowing) return
        try {
            windowManager.removeView(overlayView)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove password guard overlay", e)
        } finally {
            isShowing = false
        }
    }

    fun isVisible(): Boolean = isShowing

    /**
     * Swaps this overlay's own content to a cooldown message instead of
     * hiding it - called from [onUnlocked] when a correct password doesn't
     * (yet) mean access is granted. The overlay - and the block on the
     * screen underneath it - stays up throughout; only what's drawn inside
     * it changes, so there's never a frame with the real guarded screen
     * exposed and nothing covering it.
     */
    fun showCooldown(message: String) {
        cooldownText.text = message
        formGroup.visibility = View.GONE
        cooldownGroup.visibility = View.VISIBLE
    }

    private fun showForm() {
        formGroup.visibility = View.VISIBLE
        cooldownGroup.visibility = View.GONE
    }

    private fun attemptUnlock() {
        val entered = input.text?.toString().orEmpty()
        if (onVerify(entered)) {
            // Deliberately does NOT hide() unconditionally here - onUnlocked
            // decides whether that's actually warranted (delay-before-unlock
            // off, or its cooldown already elapsed) or whether this overlay
            // needs to switch to the cooldown message instead via
            // showCooldown().
            onUnlocked()
        } else {
            errorText.visibility = View.VISIBLE
            input.setText("")
        }
    }

    private fun buildView(): View {
        val container = FrameLayout(service).apply {
            setBackgroundColor(Color.BLACK)
            isClickable = true
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, keyEvent ->
                if (keyCode == KeyEvent.KEYCODE_BACK && keyEvent.action == KeyEvent.ACTION_UP) {
                    hide()
                    onCancelled()
                    true
                } else {
                    false
                }
            }
        }

        val dialogBox = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            setPadding(dp(24), dp(20), dp(24), dp(8))
        }

        formGroup = LinearLayout(service).apply { orientation = LinearLayout.VERTICAL }

        val title = TextView(service).apply {
            text = service.getString(R.string.password_guard_title)
            setTextColor(Color.parseColor("#212121"))
            textSize = 16f
        }
        formGroup.addView(title, wrapContentParams())

        input = EditText(service).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(Color.parseColor("#212121"))
            setOnEditorActionListener { _, _, _ -> attemptUnlock(); true }
        }
        formGroup.addView(input, wrapContentParams().apply { topMargin = dp(12) })

        errorText = TextView(service).apply {
            text = service.getString(R.string.password_guard_wrong)
            setTextColor(Color.RED)
            textSize = 12f
            visibility = View.GONE
        }
        formGroup.addView(errorText, wrapContentParams().apply { topMargin = dp(4) })

        val buttonRow = LinearLayout(service).apply { orientation = LinearLayout.HORIZONTAL }
        val cancelButton = TextView(service).apply {
            text = service.getString(R.string.password_guard_cancel)
            setTextColor(Color.parseColor("#757575"))
            textSize = 14f
            setPadding(dp(12), dp(20), dp(12), dp(4))
            isClickable = true
            isFocusable = true
            setOnClickListener { hide(); onCancelled() }
        }
        val unlockButton = TextView(service).apply {
            text = service.getString(R.string.password_guard_unlock)
            setTextColor(Color.parseColor("#0088CC"))
            textSize = 14f
            setPadding(dp(12), dp(20), dp(0), dp(4))
            isClickable = true
            isFocusable = true
            setOnClickListener { attemptUnlock() }
        }
        buttonRow.addView(cancelButton)
        buttonRow.addView(unlockButton)
        formGroup.addView(
            FrameLayout(service).apply {
                addView(buttonRow, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END))
            },
            wrapContentParams(),
        )
        dialogBox.addView(formGroup, wrapContentParams())

        // Anti-impulse cooldown display (delay-before-unlock): shown instead
        // of the form above - see showCooldown()/onUnlocked in
        // ContentGuardService - when a correct password doesn't (yet) mean
        // access is granted. Starts hidden; the same overlay just swaps
        // which of these two groups is visible, so the guarded screen
        // behind it is never left uncovered.
        cooldownGroup = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        val cooldownTitle = TextView(service).apply {
            text = service.getString(R.string.password_guard_cooldown_title)
            setTextColor(Color.parseColor("#212121"))
            textSize = 16f
        }
        cooldownGroup.addView(cooldownTitle, wrapContentParams())

        cooldownText = TextView(service).apply {
            setTextColor(Color.parseColor("#212121"))
            textSize = 13f
        }
        cooldownGroup.addView(cooldownText, wrapContentParams().apply { topMargin = dp(8) })

        val dismissButton = TextView(service).apply {
            text = service.getString(R.string.password_guard_cooldown_dismiss)
            setTextColor(Color.parseColor("#757575"))
            textSize = 14f
            setPadding(dp(12), dp(20), dp(12), dp(4))
            isClickable = true
            isFocusable = true
            setOnClickListener { hide(); onCancelled() }
        }
        cooldownGroup.addView(
            FrameLayout(service).apply {
                addView(dismissButton, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END))
            },
            wrapContentParams().apply { topMargin = dp(4) },
        )
        dialogBox.addView(cooldownGroup, wrapContentParams())

        container.addView(
            dialogBox,
            FrameLayout.LayoutParams(dp(280), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        return container
    }

    private fun wrapContentParams() =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    private fun dp(value: Int): Int = (value * service.resources.displayMetrics.density).toInt()

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            0,
            PixelFormat.TRANSLUCENT,
        )
        params.gravity = Gravity.TOP or Gravity.START
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        return params
    }

    companion object {
        private const val TAG = "PasswordGuardOverlay"
    }
}
