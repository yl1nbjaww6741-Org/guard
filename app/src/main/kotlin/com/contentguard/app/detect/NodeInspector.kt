package com.contentguard.app.detect

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

data class NodeScanResult(
    val hasImages: Boolean,
    val imageBounds: List<Rect>,
    val visibleText: String,
)

/** Gate 3 of the cascade: is there even image-shaped content on screen? */
object NodeInspector {

    private const val MAX_DEPTH = 12
    private const val MAX_NODES = 400
    private const val MIN_NODE_SIZE_PX = 64

    private val IMAGE_CLASS_HINTS = listOf("ImageView", "WebView", "SurfaceView", "TextureView", "VideoView")

    /** Does not recycle [root] - the caller owns that node's lifecycle. */
    fun scan(root: AccessibilityNodeInfo?): NodeScanResult {
        if (root == null) return NodeScanResult(hasImages = false, imageBounds = emptyList(), visibleText = "")

        val bounds = mutableListOf<Rect>()
        val text = StringBuilder()
        var visited = 0

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH || visited >= MAX_NODES) return
            visited++

            val className = node.className?.toString().orEmpty()
            if (IMAGE_CLASS_HINTS.any { className.contains(it) }) {
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.width() >= MIN_NODE_SIZE_PX && rect.height() >= MIN_NODE_SIZE_PX) {
                    bounds.add(rect)
                }
            }

            node.text?.let { if (it.isNotBlank()) text.append(it).append(' ') }
            node.contentDescription?.let { if (it.isNotBlank()) text.append(it).append(' ') }

            for (i in 0 until node.childCount) {
                if (visited >= MAX_NODES) break
                val child = node.getChild(i) ?: continue
                try {
                    walk(child, depth + 1)
                } finally {
                    @Suppress("DEPRECATION")
                    child.recycle()
                }
            }
        }

        walk(root, 0)
        return NodeScanResult(bounds.isNotEmpty(), bounds, text.toString().trim())
    }
}
