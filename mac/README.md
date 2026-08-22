# ContentGuard for macOS

This directory holds the macOS side of ContentGuard: the same kind of
self-imposed, hard-to-disable content blocking the Android app
(`app/`) implements, extended to a Mac via fleet management, a native
on-device blocker, and app execution control.

## Build order

The macOS build is six phases, done strictly in order - each one depends on
state the previous phase left behind, and each has its own verification
checklist before moving on:

| Phase | What | Status |
|---|---|---|
| 0 | First-boot Mac setup: accounts, FileVault, Find My Mac, dev tools, WARP | done - accounts, Find My Mac, dev tools, Zero Trust/WARP all verified. FileVault and the admin account rename deliberately deferred; must land before Phase 5. |
| 1 | Fleet MDM on Fly.io, enrollment, `.mobileconfig` profiles | **done** - Fleet deployed, Mac enrolled and confirmed supervised, all 3 non-Phase-2 profiles pushed and verified (PPPC pending Phase 2), Fleet Premium purchased, Recovery Lock set and reboot-tested, all six verification tests passed, WARP switch locked, Gateway NSFW category block and DoH-provider IP blocklist both configured. FileVault, the admin account rename, and rotating the tunnel connector token are deliberately deferred to Phase 5's pre-lockdown checklist. |
| 2 | Native AI blocker: `ContentGuardAgent` (capture + NudeNet) + `ContentGuardDaemon` (tamper anchor) | **in progress** - real end-to-end detection **confirmed working live on the Mac**: real screen capture -> ONNX Runtime + CoreML inference on the real model -> correct confidence-threshold gating (a 0.0001-confidence blip correctly ignored, a genuine 0.83-confidence detection correctly triggered) -> `com.google.Chrome` actually force-terminated. The core of Phase 2 is proven end-to-end, not just built. Daemon also run live for the first time: correctly detected a missing agent heartbeat while a risky app was running and tried to fail closed, but `FallbackCover`'s lock mechanism was broken - it assumed `CGSession -suspend`, which Apple removed all the way back in Big Sur (2020) and was never actually run until now. Replaced with `pmset displaysleepnow`, confirmed present and simpler (no Accessibility/TCC dependency). **New Phase 0/setup requirement this surfaced**: "Require password immediately after sleep or screen saver begins" must be enabled in System Settings -> Lock Screen, or the fallback just dims the display without locking anything - not yet verified as enabled on the real Mac. **Deliberate reaction change from the original spec**: on detection, the agent force-quits the frontmost app instead of covering the screen - no blackout, no daemon notification for this path. Chosen for disguise (a "crashed app" is much less suspicious/tempting-to-circumvent than an obvious block screen) over the cooldown protection the blackout approach gave; known and accepted tradeoff is that nothing stops immediately reopening the same app/site right after - no forced wait, no escalation on repeated triggers. The daemon's separate tamper-resistance (heartbeat monitoring, fail-closed if the agent goes quiet, escalation on repeated agent kills) is unchanged and still fully active - see `ContentGuardAgent/Sources/main.swift`'s `quitFrontmostApp()`. Also fixed a real SIGTRAP crash this surfaced: AppKit calls (`NSPanel`, `NSWorkspace`) were happening off the main thread from FrameProcessor's background queue - `OverlayManager.cover()/clear()` and `quitFrontmostApp()` both dispatch to main internally now. Still open: verify `EscalationManager.classifyExit(pid:)`'s exit-status mechanism for real, then run the rest of the Phase 2 verification checklist (agent relaunch after kill, escalation on kill-looping, sleep/wake resume, full-screen coverage - the "does it actually black out" checks no longer apply given the reaction change above) |
| 3 | Santa app execution control | not started - **deliberately MONITOR/blocklist mode, not the original spec's LOCKDOWN** (see `profiles/README.md`'s note on `forceAdminPasswordForAppInstallation`) - standard users install freely, the Phase 2 content blocker is the real backstop against NSFW content regardless of app, and Santa's job narrows to denylisting specific known-bad tools (Tor Browser, etc.) rather than gatekeeping everything |
| 4 | Cloudflare Worker (ratchet, Santa sync, profile generation) + web dashboard | not started |
| 5 | Lockdown: demote to standard, seal admin credentials in the vault | not started |

Do not skip ahead. Phase 2's PPPC profile needs Phase 1's Fleet instance to
push it to; Phase 5's lockdown needs every earlier phase's verification
checklist to have actually passed, or you lock yourself out of a system
that doesn't yet do what it's supposed to.

## Why Phase 0 has no code

Phase 0 is entirely manual, hands-on-the-hardware steps - creating
accounts, toggling FileVault in System Settings, installing Xcode from the
App Store, pairing WARP to a Zero Trust org. None of it is scriptable from
here: this repo is being worked on from a sandboxed cloud environment with
no access to the physical Mac, its Apple ID, or the Cloudflare account it
enrolls into. `docs/PHASE_0_SETUP.md` is the runbook to follow by hand on
the Mac itself; `scripts/verify-phase0.sh` is a script to *run on that Mac*
afterward (copy it over, or `curl`/paste it) to check the parts of Phase 0
that are actually machine-verifiable before starting Phase 1.

Phases 1-5 do produce real code and configuration (Fleet deployment
config, `.mobileconfig` profiles, the `ContentGuardAgent`/`ContentGuardDaemon`
Swift sources, the Cloudflare Worker, the dashboard) - those land in this
directory, `profiles/`, and sibling `worker/`/`web/` directories as each
phase starts, once Phase 0 is verified complete on the actual hardware.
