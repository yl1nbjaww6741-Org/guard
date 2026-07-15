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

    // Used only to decide whether to bother capturing at all - deliberately
    // looser than the per-image heuristic below. Compose's accessibility
    // semantics merging (mergeDescendants) commonly collapses an image and
    // its caption/title/metadata into one node that has real visual content
    // but also has its own text - which fails the childless-and-no-text
    // check below, so a Reddit feed card with a real thumbnail was being
    // read as "no images" while scrolling. A node this large is almost
    // certainly real content worth capturing regardless of whether it also
    // carries text.
    private const val SUBSTANTIAL_CONTENT_SIZE_PX = 150

    private val IMAGE_CLASS_HINTS = listOf("ImageView", "WebView", "SurfaceView", "TextureView", "VideoView")

    /** Does not recycle [root] - the caller owns that node's lifecycle. */
    fun scan(root: AccessibilityNodeInfo?): NodeScanResult {
        if (root == null) return NodeScanResult(hasImages = false, imageBounds = emptyList(), visibleText = "")

        val bounds = mutableListOf<Rect>()
        val text = StringBuilder()
        var visited = 0
        var hasSubstantialContent = false

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH || visited >= MAX_NODES) return
            visited++

            val className = node.className?.toString().orEmpty()
            val hasText = !node.text.isNullOrBlank()
            val rect = Rect()
            node.getBoundsInScreen(rect)

            // Compose-rendered images (Reddit's app, among many others) don't
            // expose classic View class names at all, so a className-only
            // check misses them entirely - a large leaf node with no text is
            // very likely an image/media surface regardless of framework.
            // False positives here just cost an extra screenshot; false
            // negatives mean real content silently never gets scored, which
            // is the far worse failure mode for what this app is for. Kept
            // strict (unlike hasSubstantialContent below) since this feeds
            // the crop region - too loose here and cropping degenerates back
            // to nearly the whole screen.
            val looksLikeImage = IMAGE_CLASS_HINTS.any { className.contains(it) } ||
                (node.childCount == 0 && !hasText)
            if (looksLikeImage && rect.width() >= MIN_NODE_SIZE_PX && rect.height() >= MIN_NODE_SIZE_PX) {
                bounds.add(rect)
            }

            if (rect.width() >= SUBSTANTIAL_CONTENT_SIZE_PX && rect.height() >= SUBSTANTIAL_CONTENT_SIZE_PX) {
                hasSubstantialContent = true
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
        return NodeScanResult(bounds.isNotEmpty() || hasSubstantialContent, bounds, text.toString().trim())
    }
}
