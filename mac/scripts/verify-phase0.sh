#!/bin/bash
# Checks the machine-verifiable parts of Phase 0 (see ../docs/PHASE_0_SETUP.md).
#
# Run this ON THE MAC ITSELF, after working through Phase 0 by hand - it
# can't do anything remotely, and it can't check things macOS doesn't
# expose a CLI signal for (Find My Mac, the Zero Trust dashboard config).
#
# Usage:
#   ./verify-phase0.sh [admin-account-name]
#
# admin-account-name defaults to "sysadmin" (the name used throughout
# docs/PHASE_0_SETUP.md) - pass your actual admin account's short name if
# you picked something else.

set -uo pipefail

ADMIN_USER="${1:-sysadmin}"
PASS=0
FAIL=0
MANUAL=0

ok()   { printf '  \033[32m[ OK ]\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
todo() { printf '  \033[33m[ -- ]\033[0m %s\n' "$1"; MANUAL=$((MANUAL + 1)); }

section() { printf '\n%s\n' "$1"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This only makes sense run on macOS." >&2
  exit 1
fi

section "Accounts"
if dscl . -list /Users | grep -qx "$ADMIN_USER"; then
  ok "admin account '$ADMIN_USER' exists"
  if dsmemberutil checkmembership -U "$ADMIN_USER" -G admin 2>/dev/null | grep -q "is a member"; then
    ok "'$ADMIN_USER' is in the admin group"
  else
    bad "'$ADMIN_USER' is NOT in the admin group (expected for Phase 0 - demotion is Phase 5, not now)"
  fi
else
  bad "no account named '$ADMIN_USER' found - pass the real admin short name as \$1 if you used a different one"
fi
todo "confirm your daily account exists and is the one you intend to keep using long-term"

section "FileVault"
FV_STATUS="$(fdesetup status 2>/dev/null)"
if echo "$FV_STATUS" | grep -q "FileVault is On"; then
  ok "FileVault is on"
else
  bad "FileVault is not on ($FV_STATUS)"
fi

FV_LIST="$(sudo -n fdesetup list 2>/dev/null)"
if [[ -z "$FV_LIST" ]]; then
  todo "run with sudo to check which accounts can unlock FileVault: sudo $0 $ADMIN_USER"
elif echo "$FV_LIST" | grep -q "^${ADMIN_USER},"; then
  bad "'$ADMIN_USER' can still unlock FileVault - run: sudo fdesetup remove -user $ADMIN_USER"
else
  ok "'$ADMIN_USER' is not in the FileVault unlock list"
fi
todo "confirm the FileVault recovery key is saved somewhere temporary, pending the Phase 5 vault"

section "Find My Mac"
todo "no reliable CLI signal for this - confirm by eye: System Settings > Apple ID > iCloud > Find My Mac"

section "Dev tools"
check_app() {
  if [[ -d "/Applications/$1.app" ]]; then
    ok "$1.app installed"
  else
    bad "$1.app not found in /Applications"
  fi
}
check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 on PATH ($(command -v "$1"))"
  else
    bad "$1 not found on PATH"
  fi
}

check_app "Xcode"
check_app "Google Chrome"
check_cmd flyctl
check_cmd node
check_cmd npm
check_cmd wrangler

section "Cloudflare WARP"
if command -v warp-cli >/dev/null 2>&1; then
  ok "warp-cli installed"
  WARP_STATUS="$(warp-cli status 2>/dev/null || true)"
  if echo "$WARP_STATUS" | grep -qi "Connected"; then
    ok "WARP is connected"
  else
    bad "WARP does not report Connected: $WARP_STATUS"
  fi
else
  bad "warp-cli not found - install the WARP client"
fi
todo "confirm in the Cloudflare Zero Trust dashboard: Gateway blocks adult/NSFW categories, WARP device profile is full-tunnel + auto-connect, admin override OFF, global WARP override OFF, switch-lock still OFF (locked in Phase 1, not now)"

section "Summary"
printf '  %d passed, %d failed, %d need a manual check\n' "$PASS" "$FAIL" "$MANUAL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "  Fix the FAILs above before moving on to Phase 1."
  exit 1
fi
echo "  Everything scriptable checks out - work through the manual items, then start Phase 1."
