package com.contentguard.app.overlay

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.contentguard.app.R

/**
 * Gate 8: the actual block. Uses TYPE_ACCESSIBILITY_OVERLAY, which an
 * accessibility service can add without the SYSTEM_ALERT_WINDOW
 * ("draw over other apps") permission.
 *
 * On API 31+ this uses FLAG_BLUR_BEHIND / blurBehindRadius rather than
 * RenderEffect: RenderEffect blurs the *overlay's own* rendered content,
 * which is empty here (there's nothing behind our own view to blur from
 * its perspective) - FLAG_BLUR_BEHIND is the primitive that actually blurs
 * whatever window is beneath us. Below API 31 there's no equivalent, so we
 * fall back to a solid opaque panel.
 *
 * The single view is created once and reused via addView/removeView -
 * never recreated - so repeated show/hide cycles don't churn View objects.
 */
class BlurOverlayController(
    private val service: AccessibilityService,
    private val onBackRequested: () -> Unit,
) {

    private val windowManager: WindowManager =
        service.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private val overlayView: View by lazy { buildView() }
    private var isShowing = false

    /** Must be called from the main thread. */
    fun show() {
        if (isShowing) return
        try {
            windowManager.addView(overlayView, buildLayoutParams())
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
            val bgAlpha = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 140 else 255
            setBackgroundColor(Color.argb(bgAlpha, 8, 8, 12))
            isClickable = true
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, keyEvent ->
                if (keyCode == KeyEvent.KEYCODE_BACK && keyEvent.action == KeyEvent.ACTION_UP) {
                    onBackRequested()
                    true
                } else {
                    false
                }
            }
        }
        val label = TextView(service).apply {
            text = service.getString(R.string.overlay_blocked_label)
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
        }
        container.addView(
            label,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ),
        )
        return container
    }

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            0,
            PixelFormat.TRANSLUCENT,
        )
        params.gravity = Gravity.TOP or Gravity.START
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.flags = params.flags or WindowManager.LayoutParams.FLAG_BLUR_BEHIND
            params.blurBehindRadius = BLUR_RADIUS_PX
        }
        return params
    }

    companion object {
        private const val TAG = "BlurOverlayController"
        private const val BLUR_RADIUS_PX = 90
    }
}
