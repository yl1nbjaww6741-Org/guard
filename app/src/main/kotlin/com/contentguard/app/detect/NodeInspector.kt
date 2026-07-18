package com.contentguard.app.detect

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo

data class NodeScanResult(
    val hasImages: Boolean,
    val imageBounds: List<Rect>,
    val visibleText: String,
    // What's currently focused and being typed - see KeywordBlocklist for
    // why search-intent matching deliberately doesn't use the whole-page
    // text. Sourced from findFocus(FOCUS_INPUT), NOT a manual isEditable
    // tree walk: real-device logging (round 3 of the Reddit investigation,
    // see SETUP.md) found a depth-capped walk truncating before ever
    // reaching Reddit's search box - a Compose UI commonly nests deeper
    // than a fixed depth cap suitable for image-node scanning - while
    // findFocus, an OS-level lookup with no such cap, found the same field
    // and its live-typed text every time. Gate 4b's own false-positive risk
    // doesn't change: this is still scoped to a single focused, editable
    // node, never incidental page content.
    val inputFieldText: String,
    // Diagnostic kept from the walk-based investigation: one entry per
    // isEditable node the (depth-capped) walk actually reached - now known
    // to be an incomplete picture on deeply-nested UIs, kept only as a
    // point of comparison against focusedInputDebug below.
    val editableNodeDebug: List<String>,
    val nodesVisited: Int,
    val hitLimit: Boolean,
    // The OS-level findFocus(FOCUS_INPUT) result inputFieldText above is
    // actually built from - see its own comment.
    val focusedInputDebug: String,
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

    // WebView deliberately excluded: unlike ImageView/SurfaceView/
    // TextureView/VideoView (which are normally sized to their actual
    // content), a WebView's bounds span the entire rendered page - so
    // treating it as an "image bound" for cropping purposes made the crop
    // region degenerate to nearly the whole page whenever browsing (e.g.
    // Chrome), diluting one specific photo among surrounding page content
    // exactly like the Reddit-feed dilution bug this crop mechanism was
    // built to fix - except here the crop couldn't help, because the
    // "image" it found *was* the whole page. This is why zooming in
    // worked (the photo then fills the whole WebView, so crop-to-page and
    // crop-to-photo coincide) while swiping through a page with the photo
    // as one element among others didn't. WebView presence still
    // contributes to hasSubstantialContent below regardless (its sheer
    // size guarantees that), so gate 3 itself isn't affected - only the
    // crop-region precision is.
    private val IMAGE_CLASS_HINTS = listOf("ImageView", "SurfaceView", "TextureView", "VideoView")

    /** Does not recycle [root] - the caller owns that node's lifecycle. */
    fun scan(root: AccessibilityNodeInfo?): NodeScanResult {
        if (root == null) {
            return NodeScanResult(
                hasImages = false,
                imageBounds = emptyList(),
                visibleText = "",
                inputFieldText = "",
                editableNodeDebug = emptyList(),
                nodesVisited = 0,
                hitLimit = false,
                focusedInputDebug = "root=null",
            )
        }

        val bounds = mutableListOf<Rect>()
        val text = StringBuilder()
        val editableDebug = mutableListOf<String>()
        var visited = 0
        var hasSubstantialContent = false
        var hitLimit = false

        // The actual source of inputFieldText - see its own doc comment for
        // why this replaced a manual isEditable tree walk. Not subject to
        // MAX_DEPTH/MAX_NODES: this is a single OS-level lookup, not a walk
        // we're bounding ourselves, so it isn't at risk of truncating
        // before it reaches a deeply-nested field the way the walk did.
        val focusedInput = try {
            root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        } catch (e: Exception) {
            null
        }
        val (focusedInputDebug, focusedInputText) = if (focusedInput == null) {
            "none" to ""
        } else {
            try {
                val debug = "class=${focusedInput.className} visible=${focusedInput.isVisibleToUser} editable=${focusedInput.isEditable} text=\"${focusedInput.text}\""
                val fieldText = if (focusedInput.isEditable) focusedInput.text?.toString().orEmpty() else ""
                debug to fieldText
            } finally {
                @Suppress("DEPRECATION")
                focusedInput.recycle()
            }
        }

        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > MAX_DEPTH || visited >= MAX_NODES) {
                hitLimit = true
                return
            }
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

            // Kept only as a diagnostic point of comparison against
            // focusedInputDebug above - no longer the source of
            // inputFieldText (see that field's doc comment for why: this
            // walk's own depth cap silently missed deeply-nested fields
            // that findFocus finds every time).
            if (node.isEditable) {
                editableDebug.add(
                    "class=$className depth=$depth visible=${node.isVisibleToUser()} text=\"${node.text}\"",
                )
            }

            // isVisibleToUser() gate matters specifically for IncognitoDetector's
            // content-based check (the only consumer of visibleText) - without
            // it, a node scrolled off-screen or sitting in a collapsed/hidden
            // panel still contributes its text/contentDescription here, so a
            // stray "private tab"-style label anywhere in the window's tree
            // (not just what's actually on screen) could false-positive gate 4
            // even though nothing matching is visible to the user. Doesn't
            // affect hasImages/imageBounds above - those are geometry-only and
            // already require a real size regardless of this filter.
            if (node.isVisibleToUser()) {
                node.text?.let { if (it.isNotBlank()) text.append(it).append(' ') }
                node.contentDescription?.let { if (it.isNotBlank()) text.append(it).append(' ') }
            }

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
        return NodeScanResult(
            hasImages = bounds.isNotEmpty() || hasSubstantialContent,
            imageBounds = bounds,
            visibleText = text.toString().trim(),
            inputFieldText = focusedInputText.trim(),
            editableNodeDebug = editableDebug,
            nodesVisited = visited,
            hitLimit = hitLimit,
            focusedInputDebug = focusedInputDebug,
        )
    }
}
