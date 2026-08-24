# Convenience wrapper around the real build steps. None of these targets
# will do anything on a non-macOS machine (xcodebuild/codesign/pkgbuild are
# all macOS-only) - this exists for running on the actual Mac, not in CI or
# this repo's sandbox.

.PHONY: build pkg install uninstall clean

# Builds and code-signs the Agent + Daemon via xcodebuild, without
# packaging them. Useful while iterating on Swift changes without going
# through a full pkgbuild/productbuild cycle each time.
#
# CONFIGURATION_BUILD_DIR is REQUIRED, not cosmetic - exactly the same
# lesson Installer/build-pkg.sh already learned and documents in its own
# header (lines 44-54). Without it xcodebuild writes its products to
# ~/Library/Developer/Xcode/DerivedData/<project>-<hash>/Build/Products/
# Release/, while the codesign lines below sign build/Release/ - so this
# target compiled the new code to one place and then signed whatever
# stale artifacts a previous `make pkg` happened to leave in the other,
# reporting complete success either way.
#
# Found live: a `make build` run whose Swift compiled cleanly still
# emitted a wall of "warning: Stale file '.../mac/build/Release/...' is
# located outside of the allowed root paths" and then cheerfully
# re-signed those stale binaries. The compile was real; the signed output
# was months old. Nothing downstream (`make install`) would have picked
# up the new code.
BUILD_DIR = $(CURDIR)/build/Release

build:
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardAgent -configuration Release CONFIGURATION_BUILD_DIR="$(BUILD_DIR)"
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardDaemon -configuration Release CONFIGURATION_BUILD_DIR="$(BUILD_DIR)"
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardRelease -configuration Release CONFIGURATION_BUILD_DIR="$(BUILD_DIR)"
	codesign --force --sign "ContentGuard Signing" --options runtime "$(BUILD_DIR)/ContentGuardAgent.app"
	codesign --force --sign "ContentGuard Signing" --options runtime "$(BUILD_DIR)/ContentGuardDaemon"
	codesign --force --sign "ContentGuard Signing" --options runtime "$(BUILD_DIR)/ContentGuardRelease"

# Full build -> sign -> package, producing Installer/ContentGuard-1.0.0.pkg.
# See Installer/build-pkg.sh's header comment for why this pkg is unsigned
# at the package level (deliberate, not an oversight).
pkg:
	./Installer/build-pkg.sh

# Installs the three sub-packages `make pkg` just built. Requires `make pkg`
# (or an equivalent manual build) to have run first - this target doesn't
# rebuild, it only installs whatever .pkg files already exist, so a stale
# build installs stale code. Requires sudo; not run as part of this target
# so the password prompt is visible.
#
# Installs the THREE sub-packages directly, not the combined
# ContentGuard-1.0.0.pkg productbuild wraps them into - confirmed live on
# the real Mac (macOS 26.5): `sudo installer` refuses the combined product
# with "This package requires Rosetta 2 to be installed," even though
# every binary in it is 100% native arm64 (build-pkg.sh's own final step
# checks this with `file` on every Mach-O and greps every
# PackageInfo/Distribution for an architecture restriction - there is
# none). The Rosetta check is a bug in productbuild's product-archive
# wrapper on this macOS version, not anything this install actually
# needs. build-pkg.sh's own final echo already prints this exact fix and
# confirms it as working - this target just automates what it says to do
# by hand.
install:
	sudo installer -pkg Installer/contentguard-app.pkg -target /
	sudo installer -pkg Installer/daemon-plist.pkg -target /
	sudo installer -pkg Installer/agent-plist.pkg -target /

# Reverses `make install`: unloads both launchd jobs and removes every
# file this project puts on disk. Does NOT touch the profiles pushed via
# Fleet (profiles/*.mobileconfig) - those are managed separately, through
# Fleet's own UI/API, not by this Makefile. Also does not touch
# /usr/local/var/lib/contentguard's contents beyond removing the directory
# itself - there's no persistent state there yet worth calling out
# separately, but if that changes this target should be revisited.
uninstall:
	sudo launchctl bootout system/com.contentguard.daemon 2>/dev/null || true
	sudo launchctl bootout gui/$$(id -u)/com.contentguard.agent 2>/dev/null || true
	sudo rm -rf /usr/local/bin/ContentGuardAgent.app
	sudo rm -f /usr/local/bin/ContentGuardDaemon
	sudo rm -f /usr/local/bin/contentguard-release
	sudo rm -rf /usr/local/share/contentguard
	sudo rm -rf /usr/local/var/log/contentguard
	sudo rm -rf /usr/local/var/lib/contentguard
	sudo rm -f /Library/LaunchDaemons/com.contentguard.daemon.plist
	sudo rm -f /Library/LaunchAgents/com.contentguard.agent.plist

clean:
	rm -rf build Installer/pkg-root Installer/*.pkg
