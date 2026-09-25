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

    // The daemon-down warning banner, one per screen while it's showing,
    // empty otherwise - see showDaemonDownWarning(). Main thread only.
    private var warningPanels: [NSPanel] = []

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
        Set(panels.values.map(\.windowNumber) + warningPanels.map(\.windowNumber))
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

    // MARK: - Daemon-down warning

    /// A red strip across the top of every screen saying the daemon isn't
    /// running, shown by HeartbeatClient.onDaemonReachabilityChanged and
    /// kept up until the daemon answers again.
    ///
    /// Deliberately a click-through banner, not cover(): the agent covering
    /// the screen on its own has already caused a real lockout on this Mac
    /// once (see main.swift's classifier-failure comment), and "the daemon
    /// is gone" is exactly the state where nothing else is around to clear
    /// a cover again. The point is that the daemon being disabled can't go
    /// unnoticed for weeks again, not to block the machine over it.
    func showDaemonDownWarning() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.warningPanels.isEmpty else { return }
            self.warningPanels = NSScreen.screens.map(self.makeWarningPanel(for:))
            for panel in self.warningPanels {
                panel.orderFrontRegardless()
            }
        }
    }

    func hideDaemonDownWarning() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for panel in self.warningPanels {
                panel.orderOut(nil)
            }
            self.warningPanels.removeAll()
        }
    }

    private func makeWarningPanel(for screen: NSScreen) -> NSPanel {
        let height: CGFloat = 44
        // visibleFrame, not frame, so the strip sits just under the menu
        // bar rather than behind it.
        let frame = NSRect(
            x: screen.frame.minX,
            y: screen.visibleFrame.maxY - height,
            width: screen.frame.width,
            height: height
        )
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = true
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.backgroundColor = NSColor(calibratedRed: 0.72, green: 0.11, blue: 0.11, alpha: 1.0)

        let label = NSTextField(labelWithString:
            "ContentGuard's background service isn't running - protection is reduced. " +
            "Re-enable it: sudo launchctl enable system/com.contentguard.daemon"
        )
        label.font = NSFont.boldSystemFont(ofSize: 13)
        label.textColor = .white
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false

        let contentView = NSView(frame: NSRect(origin: .zero, size: frame.size))
        contentView.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
        ])
        panel.contentView = contentView
        return panel
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
        for panel in warningPanels {
            panel.orderFrontRegardless()
        }
        guard isCovering else { return }
        for panel in panels.values {
            panel.orderFrontRegardless()
        }
    }
}
