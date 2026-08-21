// The daemon-held countdown that's the whole point of the "blackout" design
// versus a blur-flicker model: once started, only the daemon itself can end
// it, on its own clock. Killing the agent, quitting Chrome, closing any app
// does not cancel this - see mac/README.md's key decisions.

import Foundation

final class BlackoutTimer {
    private let queue = DispatchQueue(label: "com.contentguard.daemon.blackout")
    private var timer: DispatchSourceTimer?
    private(set) var isActive = false
    private(set) var activeDetection: BlackoutData?

    private let onStart: (BlackoutData) -> Void
    private let onEnd: () -> Void

    init(onStart: @escaping (BlackoutData) -> Void, onEnd: @escaping () -> Void) {
        self.onStart = onStart
        self.onEnd = onEnd
    }

    /// A new detection while already blacked out restarts the full
    /// countdown rather than stacking or being ignored - still-active
    /// exposure is still active exposure, the timer reflects "how long since
    /// the most recent confirmed detection," not "how long since the first."
    func start(detection: BlackoutData) {
        queue.async { [weak self] in
            guard let self else { return }
            self.timer?.cancel()
            self.isActive = true
            self.activeDetection = detection

            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now() + ContentGuardConfig.blackoutDurationSeconds)
            t.setEventHandler { [weak self] in
                self?.finish()
            }
            t.resume()
            self.timer = t

            self.onStart(detection)
        }
    }

    /// The only other way a blackout ends besides natural expiry -
    /// AdminRelease.swift calls this, and only after a real
    /// AuthorizationServices check succeeds. Never call this from anywhere
    /// that isn't gated on that check.
    func adminRelease() {
        queue.async { [weak self] in
            self?.finish()
        }
    }

    private func finish() {
        timer?.cancel()
        timer = nil
        isActive = false
        activeDetection = nil
        onEnd()
    }
}
