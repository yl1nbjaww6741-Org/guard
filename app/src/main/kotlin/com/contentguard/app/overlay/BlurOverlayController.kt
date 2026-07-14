package com.contentguard.app.overlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.contentguard.app.R

/**
 * Gate 8: the actual block. Uses TYPE_ACCESSIBILITY_OVERLAY, which an
 * accessibility service can add without the SYSTEM_ALERT_WINDOW
 * ("draw over other apps") permission.
 *
 * Deliberately styled as a fake "Unfortunately, the process X has
 * stopped." system dialog rather than an obvious "Content blocked"
 * panel - this is a commitment-device choice: a believable crash dialog
 * discourages retrying/routing around the block far better than a
 * screen that visibly announces a content blocker is running. The
 * backdrop is solid black (not blurred), matching what a real crashed
 * app's torn-down window looks like. [blockedPackageName] is
 * interpolated into the message per-show so it names whatever app was
 * actually blocked, not this app.
 *
 * Persistence: this view is only ever dismissed by (a) a genuine app
 * switch away from the blocked app, or (b) the user tapping "OK" /
 * pressing back - never by the cascade re-evaluating background content
 * changes underneath it as "safe". That distinction matters: earlier,
 * exitSafe() in ContentGuardService hid the overlay on every safe gate
 * exit, which meant autoplay advancing, an ad rotating, or infinite
 * scroll loading fresh content in the background could silently dismiss
 * an active block with no user action at all. See ContentGuardService.
 *
 * The single view is created once and reused via addView/removeView -
 * never recreated - so repeated show/hide cycles don't churn View
 * objects; only its message text is updated per show() call.
 */
class BlurOverlayController(
    private val service: AccessibilityService,
    private val onBackKeyPressed: () -> Unit,
    private val onOkTapped: () -> Unit,
) {

    private val windowManager: WindowManager =
        service.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private lateinit var messageText: TextView
    private val overlayView: View by lazy { buildView() }
    private var isShowing = false

    /** Must be called from the main thread. */
    fun show(blockedPackageName: String) {
        val view = overlayView // ensures buildView() (and messageText) ran first
        messageText.text = service.getString(R.string.fake_crash_message, blockedPackageName)

        if (isShowing) return
        try {
            windowManager.addView(view, buildLayoutParams())
            isShowing = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to add overlay view", e)
        }
    }

    /** Must be called from the main thread. */
    fun hide() {
        if (!isShowing) return
        try {
            windowManager.removeView(overlayView)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to remove overlay view", e)
        } finally {
            isShowing = false
        }
    }

    fun isVisible(): Boolean = isShowing

    private fun buildView(): View {
        val container = FrameLayout(service).apply {
            setBackgroundColor(Color.BLACK)
            isClickable = true
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, keyEvent ->
                if (keyCode == KeyEvent.KEYCODE_BACK && keyEvent.action == KeyEvent.ACTION_UP) {
                    onBackKeyPressed()
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

        messageText = TextView(service).apply {
            setTextColor(Color.parseColor("#212121"))
            textSize = 16f
        }
        dialogBox.addView(
            messageText,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )

        val okButton = TextView(service).apply {
            text = service.getString(R.string.fake_crash_ok)
            setTextColor(Color.parseColor("#0088CC"))
            textSize = 14f
            setPadding(dp(12), dp(20), dp(0), dp(4))
            isClickable = true
            isFocusable = true
            setOnClickListener {
                hide()
                onOkTapped()
            }
        }
        dialogBox.addView(
            FrameLayout(service).apply {
                addView(okButton, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.END))
            },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
        )

        container.addView(
            dialogBox,
            FrameLayout.LayoutParams(dp(280), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        return container
    }

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
        return params
    }

    companion object {
        private const val TAG = "BlurOverlayController"
    }
}
