# Convenience wrapper around the real build steps. None of these targets
# will do anything on a non-macOS machine (xcodebuild/codesign/pkgbuild are
# all macOS-only) - this exists for running on the actual Mac, not in CI or
# this repo's sandbox.

.PHONY: build pkg install uninstall clean

# Builds and code-signs the Agent + Daemon via xcodebuild, without
# packaging them. Useful while iterating on Swift changes without going
# through a full pkgbuild/productbuild cycle each time.
build:
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardAgent -configuration Release
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardDaemon -configuration Release
	xcodebuild -project ContentGuard.xcodeproj -scheme ContentGuardRelease -configuration Release
	codesign --force --sign "ContentGuard Signing" --options runtime build/Release/ContentGuardAgent.app
	codesign --force --sign "ContentGuard Signing" --options runtime build/Release/ContentGuardDaemon
	codesign --force --sign "ContentGuard Signing" --options runtime build/Release/ContentGuardRelease

# Full build -> sign -> package, producing Installer/ContentGuard-1.0.0.pkg.
# See Installer/build-pkg.sh's header comment for why this pkg is unsigned
# at the package level (deliberate, not an oversight).
pkg:
	./Installer/build-pkg.sh

# Installs the most recently built pkg. Requires `make pkg` (or an
# equivalent manual build) to have run first - this target doesn't rebuild,
# it only installs whatever .pkg already exists, so a stale pkg installs
# stale code. Requires sudo; not run as part of this target so the
# password prompt is visible.
install:
	sudo installer -pkg Installer/ContentGuard-1.0.0.pkg -target /

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
