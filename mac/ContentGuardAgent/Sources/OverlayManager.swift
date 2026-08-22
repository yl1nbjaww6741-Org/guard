// One borderless, non-activating panel per display, at .screenSaver window
// level so it sits above normal app windows including full-screen apps.
// Two states only: cover (blocks clicks, opaque) and clear (click-through,
// hidden). CaptureManager needs to exclude these panels' own windows from
// capture - see ownWindows(on:) below, which is how AppScopeManager/
// CaptureManager's excludingWindows: list gets the overlay's own SCWindow
// entries, matched by CGWindowID.

import AppKit
import ScreenCaptureKit

final class OverlayManager {
    private var panels: [CGDirectDisplayID: NSPanel] = [:]
    private(set) var isCovering = false

    init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleActiveSpaceChange),
            name: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil
        )
        rebuildPanels()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    /// The window numbers (== CGWindowID) of every panel this manager owns.
    /// CaptureManager filters a fresh SCShareableContent.windows list down
    /// to entries whose windowID is in this set, to build its
    /// excludingWindows: filter - without this, the overlay would capture
    /// itself whenever it's covering, a positive detection covering a
    /// positive detection, indefinitely.
    var ownWindowNumbers: Set<Int> {
        Set(panels.values.map(\.windowNumber))
    }

    /// Dispatches to the main thread internally rather than trusting every
    /// caller to already be on it - found the hard way: FrameProcessor
    /// runs its pipeline on a background queue, and its delegate callback
    /// called this directly, which crashed (SIGTRAP) the instant a real
    /// detection fired, since NSPanel/NSView/CALayer are AppKit and AppKit
    /// is not thread-safe. Same story for the CaptureManager.start()
    /// failure path in main.swift's un-annotated Task block. Guaranteeing
    /// main-thread execution here, once, is more robust than auditing
    /// every current and future call site.
    func cover() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.isCovering = true
            for panel in self.panels.values {
                panel.ignoresMouseEvents = false
                panel.contentView?.layer?.backgroundColor = NSColor.black.cgColor
                panel.alphaValue = 1.0
                panel.orderFrontRegardless()
            }
        }
    }

    func clear() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.isCovering = false
            for panel in self.panels.values {
                panel.ignoresMouseEvents = true
                panel.alphaValue = 0.0
            }
        }
    }

    // MARK: - Panel lifecycle

    private func rebuildPanels() {
        for panel in panels.values {
            panel.orderOut(nil)
        }
        panels.removeAll()

        for screen in NSScreen.screens {
            guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
                continue
            }
            panels[displayID] = makePanel(for: screen)
        }
    }

    private func makePanel(for screen: NSScreen) -> NSPanel {
        let panel = NSPanel(
            contentRect: screen.frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.alphaValue = 0.0

        let contentView = NSView(frame: screen.frame)
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor.black.cgColor
        panel.contentView = contentView

        return panel
    }

    @objc private func handleActiveSpaceChange() {
        // Re-assert ordering on space changes - collectionBehavior should
        // keep the panel visible across spaces already, but re-asserting
        // orderFrontRegardless() when actively covering guards against any
        // ordering hiccup during the transition rather than assuming
        // collectionBehavior alone is airtight.
        guard isCovering else { return }
        for panel in panels.values {
            panel.orderFrontRegardless()
        }
    }
}
