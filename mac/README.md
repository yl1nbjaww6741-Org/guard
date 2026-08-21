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
| 1 | Fleet MDM on Fly.io, enrollment, `.mobileconfig` profiles | **in progress** - Fleet deployed, Mac enrolled and confirmed supervised, 3 of 4 profiles pushed (PPPC pending Phase 2), Fleet Premium purchased and Recovery Lock enabled. Last step before Phase 2: the six verification tests, then lock the WARP switch. |
| 2 | Native AI blocker: `ContentGuardAgent` (capture + NudeNet) + `ContentGuardDaemon` (tamper anchor) | not started - **first step is `docs/PHASE_2_SIGNING_TEST.md`**, before writing any agent/daemon code, since its outcome (self-signed cert vs. \$99/year Apple Developer ID) decides the signing strategy for everything else in this phase |
| 3 | Santa app execution control (LOCKDOWN mode) | not started |
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
