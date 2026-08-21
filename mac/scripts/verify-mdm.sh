#!/bin/bash
# ContentGuard MDM Verification
#
# Run ON THE MAC ITSELF to check that Fleet's pushed profiles are actually
# in effect, not just sitting in Fleet's dashboard as "delivered."
#
# Two passes:
#   - No-sudo pass: profile *presence*, Chrome managed policy (world-readable
#     under /Library/Managed Preferences), WARP status, FileVault status.
#     This is what runs by default, as your daily (still-admin, soon to be
#     standard) account would see it.
#   - Sudo pass: actual restriction *values* from the full profile XML dump.
#     `sudo profiles -P -o stdout-xml` requires root - Apple gates the full
#     dump behind it since profiles can embed other sensitive payload data
#     (Wi-Fi/VPN secrets, etc). Run this script with `sudo` to include it;
#     without sudo, that section is skipped with a note, not silently wrong.
#
# Usage:
#   ./verify-mdm.sh            # no-sudo checks only
#   sudo ./verify-mdm.sh       # full run, including restriction values
#
# A handful of things genuinely can't be checked without either a reboot
# or physically interacting with an app - those print as MANUAL, not PASS/FAIL.

PASS=0
FAIL=0
WARN=0
MANUAL=0

pass()   { printf '  \033[32m✅ PASS:\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail()   { printf '  \033[31m❌ FAIL:\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn()   { printf '  \033[33m⚠️  WARN:\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
manual() { printf '  🔍 MANUAL: %s\n' "$1"; MANUAL=$((MANUAL + 1)); }
section() { printf '\n━━━ %s ━━━\n' "$1"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This only makes sense run on macOS." >&2
  exit 1
fi

HAVE_SUDO=false
if [[ "$EUID" -eq 0 ]]; then
  HAVE_SUDO=true
fi

echo "ContentGuard MDM Verification"
echo "=============================="
echo "Date: $(date)"
echo "Host: $(hostname)"
echo "User: $(whoami)"
echo "macOS: $(sw_vers -productVersion)"
echo "Running with sudo: $HAVE_SUDO"

# --- Section 1: profile presence (no sudo needed) ---
section "1. Installed profiles (presence only)"
PROFILE_LIST="$(profiles list 2>/dev/null)"
for id in com.contentguard.restrictions com.contentguard.chrome com.contentguard.dns; do
  if echo "$PROFILE_LIST" | grep -q "$id"; then
    pass "profile installed: $id"
  else
    fail "profile NOT found: $id"
  fi
done
if echo "$PROFILE_LIST" | grep -qi "fleet"; then
  pass "Fleet MDM enrollment profile present"
else
  fail "Fleet MDM enrollment profile NOT found"
fi
echo "  (values, not just presence, need the sudo pass below)"

# --- Section 2: restriction values (sudo only) ---
section "2. Restrictions (com.apple.applicationaccess) - values"
if [[ "$HAVE_SUDO" != true ]]; then
  warn "skipped - re-run with sudo to check actual restriction values, not just profile presence"
else
  RESTRICTIONS_XML="$(profiles -P -o stdout-xml 2>/dev/null)"
  check_bool_key() {
    local key="$1" expected="$2"
    local found
    found="$(echo "$RESTRICTIONS_XML" | grep -A1 "<key>$key</key>" | tail -1 | grep -oE 'true|false')"
    if [[ "$found" == "$expected" ]]; then
      pass "$key = $found"
    elif [[ -z "$found" ]]; then
      fail "$key not found in profile XML (expected $expected)"
    else
      fail "$key = $found (expected $expected)"
    fi
  }
  check_bool_key allowCloudPrivateRelay false
  check_bool_key allowEraseContentAndSettings false
  check_bool_key allowAirDrop false
  check_bool_key allowLocalUserCreation false
  check_bool_key allowAccountModification false
  check_bool_key allowUIConfigurationProfileInstallation false
  check_bool_key allowStartupDiskModification false
  check_bool_key forceAdminPasswordForAppInstallation true
  check_bool_key allowScreenshotsAndScreenRecording false
  check_bool_key forceBypassScreenCaptureAlert true
fi
manual "System Settings > Apple ID > iCloud > Private Relay - greyed out / managed?"
manual "System Settings > General > Transfer or Reset Mac - 'Erase All Content and Settings' greyed out / absent?"
manual "Finder > AirDrop - shows disabled/unavailable?"
manual "Try double-clicking a .mobileconfig file - should be rejected, not install"

# --- Section 3: Chrome managed policy (no sudo needed - world-readable) ---
section "3. Chrome managed policy"
CHROME_PLIST="/Library/Managed Preferences/com.google.Chrome.plist"
if [[ -f "$CHROME_PLIST" ]]; then
  pass "Chrome managed preferences file exists"
else
  fail "Chrome managed preferences file not found at $CHROME_PLIST"
fi
check_chrome_key() {
  local key="$1" expected="$2"
  local found
  found="$(defaults read "$CHROME_PLIST" "$key" 2>/dev/null)"
  if [[ "$found" == "$expected" ]]; then
    pass "$key = $found"
  elif [[ -z "$found" ]]; then
    fail "$key not set (expected $expected)"
  else
    fail "$key = $found (expected $expected)"
  fi
}
check_chrome_key DeveloperToolsAvailability 2
check_chrome_key IncognitoModeAvailability 1
check_chrome_key BrowserGuestModeEnabled 0
check_chrome_key DnsOverHttpsMode off
check_chrome_key BrowserSignin 0
if defaults read "$CHROME_PLIST" ExtensionInstallBlocklist 2>/dev/null | grep -q '"\*"'; then
  pass "ExtensionInstallBlocklist contains *"
else
  fail "ExtensionInstallBlocklist missing or doesn't contain *"
fi
manual "Open chrome://policy - all policies listed there too?"
manual "Cmd+Shift+I in Chrome - DevTools should NOT open"
manual "Cmd+Shift+N in Chrome - Incognito should NOT open"
manual "Chrome Settings > Security > 'Use secure DNS' - greyed out/managed?"

# --- Section 4: DNS ---
section "4. DNS settings"
if [[ "$HAVE_SUDO" == true ]]; then
  if echo "$RESTRICTIONS_XML" | grep -q "dnsSettings"; then
    pass "managed DNS profile present in profile XML"
  else
    fail "no dnsSettings payload found in profile XML"
  fi
  found="$(echo "$RESTRICTIONS_XML" | grep -A1 "<key>ProhibitDisablement</key>" | tail -1 | grep -oE 'true|false')"
  if [[ "$found" == "true" ]]; then
    pass "ProhibitDisablement = true"
  else
    fail "ProhibitDisablement not true (found: ${found:-none})"
  fi
else
  warn "skipped - re-run with sudo for the dnsSettings/ProhibitDisablement checks"
fi
echo "  Current resolver config (informational, not pass/fail):"
scutil --dns 2>/dev/null | grep -A1 "nameserver\[0\]" | head -6
manual "System Settings > Network > DNS - greyed out / shows 'managed'?"
warn "the 'resolve a Gateway-blocked domain, expect it to fail' test depends on the Gateway category block actually being configured - which is still an open item as of this session, not yet confirmed. Don't treat a pass/fail here as meaningful until that's resolved."

# --- Section 5: Cloudflare WARP ---
section "5. Cloudflare WARP"
if command -v warp-cli >/dev/null 2>&1; then
  WARP_STATUS="$(warp-cli status 2>/dev/null)"
  if echo "$WARP_STATUS" | grep -qi "Connected"; then
    pass "WARP status: Connected"
  else
    fail "WARP not connected: $WARP_STATUS"
  fi
  if warp-cli registration show 2>/dev/null | grep -qi "."; then
    pass "WARP shows a registration (check output below matches your org)"
    warp-cli registration show 2>/dev/null | sed 's/^/    /'
  else
    warn "could not read WARP registration info"
  fi
else
  fail "warp-cli not found"
fi
manual "Open WARP app - is the Pause/Disconnect control absent or non-functional? (expected only once the switch is locked at the end of Phase 1 - if you haven't locked it yet, this one's expected to still show a working Pause button)"
manual "Quit WARP app (Cmd+Q), reopen - does it still show Connected (or reconnect within ~1 min via Auto Connect)?"

# --- Section 6: Recovery Lock ---
section "6. Recovery Lock"
manual "Requires a reboot - restart, immediately hold the power button until 'Loading startup options' appears. A password prompt should appear BEFORE startup options. If it does: PASS. If you land straight in startup options: FAIL."

# --- Section 7: Supervision ---
section "7. Supervision status"
ENROLL_STATUS="$(profiles status -type enrollment 2>/dev/null)"
if echo "$ENROLL_STATUS" | grep -qi "User Approved"; then
  pass "MDM enrollment: User Approved"
else
  fail "MDM enrollment not showing as User Approved: $ENROLL_STATUS"
fi
echo "$ENROLL_STATUS" | sed 's/^/    /'
manual "System Settings > General > Device Management - confirm it says 'supervised' explicitly (this is the most reliable direct confirmation - already seen once during Phase 1 enrollment)"

# --- Section 8: FileVault ---
section "8. FileVault"
FV_STATUS="$(fdesetup status 2>/dev/null)"
if echo "$FV_STATUS" | grep -q "FileVault is On"; then
  pass "FileVault is On"
else
  fail "FileVault is not on: $FV_STATUS (known deferred item as of this session)"
fi
if [[ "$HAVE_SUDO" == true ]]; then
  echo "  fdesetup list (who can unlock):"
  fdesetup list 2>/dev/null | sed 's/^/    /'
else
  warn "skipped 'who can unlock' check - re-run with sudo, or run 'sudo fdesetup list' manually"
fi

# --- Section 9: Find My / Activation Lock ---
section "9. Find My / Activation Lock"
manual "No reliable CLI signal for this - confirm by eye: System Settings > Apple ID > iCloud > Find My Mac = On"

# --- Section 10: System extensions ---
section "10. System extensions"
EXT_LIST="$(systemextensionsctl list 2>/dev/null)"
echo "$EXT_LIST" | sed 's/^/    /'
if echo "$EXT_LIST" | grep -qi "0 extension"; then
  pass "0 system extensions active - EXPECTED for WARP (its packet tunnel runs as a Network/App Extension, not a System Extension - confirmed directly on this Mac during Phase 1). Not a failure."
else
  echo "  (extensions found - if Santa is installed, look for its EndpointSecurity extension as 'activated enabled' here; if not installed yet, anything unexpected here is worth a closer look)"
fi

# --- Summary ---
section "Summary"
printf '  ✅ Passed:   %d\n' "$PASS"
printf '  ❌ Failed:   %d\n' "$FAIL"
printf '  ⚠️  Warnings: %d\n' "$WARN"
printf '  🔍 Manual:   %d\n' "$MANUAL"
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All automated checks passed."
else
  echo "⚠️  $FAIL check(s) failed - review the output above."
fi
if [[ "$MANUAL" -gt 0 ]]; then
  echo "🔍 $MANUAL check(s) require manual verification."
fi
if [[ "$HAVE_SUDO" != true ]]; then
  echo "ℹ️  Re-run with sudo for the full pass (restriction values, DNS payload, FileVault unlock list)."
fi
