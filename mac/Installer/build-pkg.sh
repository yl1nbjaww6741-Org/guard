#!/bin/bash
# Builds and packages ContentGuardAgent + ContentGuardDaemon into an
# installable .pkg.
#
# Two deliberate deviations from the original build-pkg.sh spec, both
# following from things confirmed earlier in Phase 2 - not oversights:
#
# 1. No Developer ID Installer signing on the .pkg itself, no notarization.
#    The original spec's script signed the pkg with a "Developer ID
#    Installer" identity and ran `notarytool submit ... --wait`. Both of
#    those exist to satisfy Gatekeeper's "verify with Apple" check, which
#    only fires on content carrying the com.apple.quarantine extended
#    attribute - i.e. content downloaded from the internet. This package is
#    built and installed entirely locally, on the same machine, by the same
#    person - it never crosses a network boundary that would set the
#    quarantine flag, so there's nothing for Gatekeeper's notarization
#    check to trigger on. Notarization also requires a paid Apple Developer
#    Program account, which the whole Phase 2 signing test was run
#    specifically to avoid needing. `sudo installer -pkg` installs an
#    unsigned local package without complaint under normal circumstances -
#    worth confirming this holds on the actual Mac before fully trusting it,
#    same as everything else in this file that's stated with confidence but
#    hasn't been run for real yet.
#
# 2. codesign still happens, and still matters - just for the app/daemon
#    binaries themselves, using the self-signed "ContentGuard Signing"
#    identity confirmed working for PPPC in the Phase 2 signing test. That's
#    a completely different thing from pkg-level signing (#1 above): TCC
#    cares about the code signature on the actual running binary, not
#    whether the installer package that delivered it was signed.
#
# Assumes ContentGuard.xcodeproj already exists with Agent and Daemon
# targets wired to the Sources/ directories in this repo - the .xcodeproj
# itself isn't hand-authored here (a hand-written .pbxproj is exactly the
# kind of thing that's easy to get subtly wrong; it needs creating in Xcode
# directly on the Mac, guided step by step when that part of the build
# happens).

set -euo pipefail

SIGNING_IDENTITY="ContentGuard Signing"
VERSION="1.0.0"
BUILD_DIR="build/Release"
PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building ContentGuardAgent, ContentGuardDaemon, ContentGuardRelease"
xcodebuild -project "$PKG_ROOT/ContentGuard.xcodeproj" -scheme ContentGuardAgent -configuration Release
xcodebuild -project "$PKG_ROOT/ContentGuard.xcodeproj" -scheme ContentGuardDaemon -configuration Release
xcodebuild -project "$PKG_ROOT/ContentGuard.xcodeproj" -scheme ContentGuardRelease -configuration Release

echo "==> Signing binaries with the self-signed ContentGuard Signing identity"
codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$BUILD_DIR/ContentGuardAgent.app"
codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$BUILD_DIR/ContentGuardDaemon"
codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$BUILD_DIR/ContentGuardRelease"

echo "==> Verifying signatures"
codesign --verify --verbose "$BUILD_DIR/ContentGuardAgent.app"
codesign --verify --verbose "$BUILD_DIR/ContentGuardDaemon"
codesign --verify --verbose "$BUILD_DIR/ContentGuardRelease"

echo "==> Confirming code requirement matches what's in profiles/pppc.mobileconfig"
AGENT_REQUIREMENT="$(codesign --display -r - "$BUILD_DIR/ContentGuardAgent.app" 2>&1 | sed -n 's/^designated => //p')"
echo "    $AGENT_REQUIREMENT"
echo "    If this doesn't match profiles/pppc.mobileconfig's CodeRequirement, PPPC won't apply - update and re-push the profile before installing."

echo "==> Packaging components"
mkdir -p "$PKG_ROOT/Installer/pkg-root/usr/local/bin"
mkdir -p "$PKG_ROOT/Installer/pkg-root/usr/local/share/contentguard"
mkdir -p "$PKG_ROOT/Installer/pkg-root/usr/local/var/log/contentguard"
mkdir -p "$PKG_ROOT/Installer/pkg-root/usr/local/var/lib/contentguard"

cp -R "$BUILD_DIR/ContentGuardAgent.app" "$PKG_ROOT/Installer/pkg-root/usr/local/bin/"
cp "$BUILD_DIR/ContentGuardDaemon" "$PKG_ROOT/Installer/pkg-root/usr/local/bin/"
cp "$BUILD_DIR/ContentGuardRelease" "$PKG_ROOT/Installer/pkg-root/usr/local/bin/contentguard-release"
cp "$PKG_ROOT/Model/nudenet_640m.onnx" "$PKG_ROOT/Installer/pkg-root/usr/local/share/contentguard/"

pkgbuild --root "$PKG_ROOT/Installer/pkg-root" \
         --identifier com.contentguard.pkg \
         --version "$VERSION" \
         --scripts "$PKG_ROOT/Installer/scripts" \
         "$PKG_ROOT/Installer/contentguard-app.pkg"

pkgbuild --root "$PKG_ROOT/LaunchDaemons" \
         --install-location /Library/LaunchDaemons \
         --identifier com.contentguard.daemon.plist \
         --version "$VERSION" \
         "$PKG_ROOT/Installer/daemon-plist.pkg"

pkgbuild --root "$PKG_ROOT/LaunchAgents" \
         --install-location /Library/LaunchAgents \
         --identifier com.contentguard.agent.plist \
         --version "$VERSION" \
         "$PKG_ROOT/Installer/agent-plist.pkg"

echo "==> Combining into the final installer"
productbuild --distribution "$PKG_ROOT/Installer/distribution.xml" \
             --package-path "$PKG_ROOT/Installer" \
             "$PKG_ROOT/Installer/ContentGuard-$VERSION.pkg"

echo "==> Done: Installer/ContentGuard-$VERSION.pkg (unsigned at the package level - see this script's header comment for why)"
echo "    Install with: sudo installer -pkg Installer/ContentGuard-$VERSION.pkg -target /"
