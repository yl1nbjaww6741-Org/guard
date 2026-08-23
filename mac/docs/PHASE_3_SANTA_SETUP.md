# Santa setup (Phase 3)

Goal: get Santa running in MONITOR mode with a small, hand-maintained
StaticRules denylist, pre-approved via MDM so nothing needs an interactive
click. Two decisions are already made and documented elsewhere, not
revisited here:

- **MONITOR, not LOCKDOWN** - see `profiles/README.md`'s "Deliberate
  deviation" section and `mac/README.md`'s Phase 3 row. Santa's job is
  denylisting specific known-bad tools, not gatekeeping all execution;
  Phase 2's content-capture blocker is the real backstop against NSFW
  content regardless of app.
- **StaticRules only, no sync server** - see `profiles/santa-config.mobileconfig`'s
  own comment on `SyncBaseURL`. A small hand-maintained list doesn't
  justify standing up and trusting another network service yet.

Two files already exist with real values filled in and two placeholders
still needing real-Mac data - see each file's own comments for exactly
what and why:

- `profiles/system-extension.mobileconfig` - Santa's Team ID
  (`ZMCG7MLDV9`) and both extension bundle IDs
  (`com.northpolesec.santa.daemon`, `com.northpolesec.santa.netd`)
  already filled in, confirmed via northpole.dev's own deployment docs.
  Ready to push as-is.
- `profiles/santa-config.mobileconfig` - `ClientMode=1` (MONITOR) and the
  StaticRules structure are set; `__CONTENTGUARD_CERT_SHA256__` and
  `__TOR_BROWSER_TEAMID__` are placeholders that need real values pulled
  on the Mac (Step 4 below).

## Before you start

- Fleet (Phase 1) needs to be up and the Mac enrolled - this profile push
  works the same way Phase 1's and Phase 2's profiles did.
- Fleet Premium is already purchased (Phase 1) - its **Software** library
  is what this uses to deploy Santa's `.pkg` without a manual local
  install step.

## Step 1 - Push `system-extension.mobileconfig` first

Order matters here: this profile has to be in place *before* Santa's
System Extension tries to activate, or macOS falls back to the normal
interactive approval prompt instead of the silent MDM-approved path -
the exact problem this profile exists to avoid (same reasoning as
Phase 2's PPPC profile for Screen Recording).

In Fleet's UI: **Controls > OS settings > Custom settings**, upload
`profiles/system-extension.mobileconfig`, target the Mac, confirm it
shows as applied (same flow as every other profile push this project has
done - see `profiles/README.md`'s "Pushing via Fleet" section for the
detailed walkthrough if needed).

## Step 2 - Install Santa via Fleet's Software library

1. Grab the current **standard** package (not `-lite`) from
   [northpolesec/santa's releases page](https://github.com/northpolesec/santa/releases) -
   northpole.dev's own guidance is that lite is rarely the right choice
   unless you have a specific reason otherwise, and this deployment
   doesn't have one.
2. In Fleet: **Software** (or wherever your Fleet version exposes
   package deployment) > upload the `.pkg` > target the Mac > install.
3. Confirm on the Mac:
   ```bash
   systemextensionsctl list
   ```
   Both `com.northpolesec.santa.daemon` and `com.northpolesec.santa.netd`
   should show as activated/enabled with **no approval prompt** having
   appeared. If a prompt did appear, Step 1's profile didn't apply
   cleanly before Santa tried to activate - worth fixing that before
   trusting anything else here.

## Step 2.5 - Grant Santa's daemon Full Disk Access

Not part of Santa's own docs' "quick start," but confirmed necessary live:
right after Step 2's install, `santactl status` failed outright with "An
error occurred communicating with the Santa daemon" - `com.northpolesec
.santa.daemon` needs Full Disk Access (`SystemPolicyAllFiles` in TCC
terms) to function at all, which is a separate grant from Step 1's
System Extension pre-approval.

Push `profiles/santa-tcc.mobileconfig` the same way as Step 1 (**Controls
> OS settings > Custom settings** in Fleet, target the Mac). Its content
was copied verbatim from northpole.dev's own reference TCC profile
(`northpole.dev/deployment/profile-tcc/`) rather than reconstructed by
hand, and covers all three of Santa's components (`daemon`, `netd`,
`bundleservice`) rather than narrowing to just `daemon` - matching the
vendor's own reference profile beats guessing which pieces are safe to
leave out.

Confirm on the Mac once pushed:

```bash
santactl status
```

Should no longer error - if it still can't reach the daemon after this
profile shows Verified in Fleet, check **System Settings > Privacy &
Security > Full Disk Access** directly for whether `com.northpolesec
.santa.daemon` is listed and enabled.

## Step 3 - Confirm MONITOR mode is active

```bash
santactl status
```

Should show `Mode: Monitor`. This is a no-op state until the two
StaticRules placeholders below are filled in - Santa's running, but
nothing's actually being denied yet.

## Step 4 - Get the two real values and fill in `santa-config.mobileconfig`

**ContentGuard's own certificate SHA-256** (the defense-in-depth
ALLOWLIST rule):

```bash
santactl fileinfo /usr/local/bin/ContentGuardAgent.app
```

Look for `SHA-256 (leaf signing cert)` in the output (or `codesign -dvvv
<path>` and inspect the signing chain in Keychain Access if santactl's
output format differs from what's expected). This is a different hash
from the `CodeRequirement` already used in `profiles/pppc.mobileconfig` -
that one's a legacy SHA-1-based codesign requirement hash, not
compatible with Santa's `CERTIFICATE` rule type.

**Tor Browser's Team ID** (the starter BLOCKLIST entry):

```bash
codesign -dv /Applications/Tor\ Browser.app 2>&1 | grep TeamIdentifier
```

If Tor Browser isn't installed yet, installing it just to read its
signature is safe even though it feels backwards - this only reads the
signature, and MONITOR mode doesn't block anything until this exact rule
is filled in and pushed anyway.

Fill both values into `profiles/santa-config.mobileconfig` (replacing
`__CONTENTGUARD_CERT_SHA256__` and `__TOR_BROWSER_TEAMID__`), commit,
push to the branch, then push the profile via Fleet the same way as
Step 1.

## Step 5 - Verify the rules actually took effect

```bash
santactl rule --check --path /Applications/Tor\ Browser.app
santactl rule --check --path /usr/local/bin/ContentGuardAgent.app
```

Should show `BLOCKLIST` and `ALLOWLIST` respectively. Then the real
test: launch Tor Browser (if installed) and confirm Santa actually
blocks it - MONITOR mode still enforces explicit BLOCKLIST rules, that's
the whole point of using StaticRules instead of relying on ClientMode
alone. Also confirm ContentGuardAgent/ContentGuardDaemon are unaffected -
they should be, since MONITOR mode doesn't gate anything without an
explicit rule and Phase 2's own processes were already running fine
before Santa existed, but worth confirming rather than assuming.

## Keeping the denylist small and deliberate

Per `profiles/README.md` and `santa-config.mobileconfig`'s own
StaticRules comment: add entries as real gaps show up, not
preemptively. Tor Browser is the one named in the original Phase 3 scope
- resist the urge to front-load a long list of "obvious" additions
without a real reason for each one.
