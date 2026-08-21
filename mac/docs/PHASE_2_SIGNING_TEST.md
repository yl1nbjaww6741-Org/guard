# Self-signed certificate test (do this before building Phase 2 for real)

**Result: self-signed passed all three tests, run on the real Mac.
Skipping the Apple Developer ID.** Certificate is `"ContentGuard
Signing"` in the login keychain, code requirement
`identifier "<bundle id>" and certificate root = H"cda6539309367d134e61fb248ba54c7e1386268e"`
(swap `<bundle id>` for the real one, e.g. `com.contentguard.agent` -
the certificate root hash stays the same regardless of bundle ID, since
it's bound to the cert, not the app). Test A (Accessibility) and Test B
(Screen Recording) were both silently granted and shown as "configured
by a profile" with the toggle locked against manual changes - Test B
didn't even need the standard-user click-to-approve step the original
test envisioned. Test C confirmed the code requirement survives a
rebuild unchanged. Full transcript of this run isn't reproduced here;
this file stays as the reusable test procedure for reference.

Goal: determine whether a self-signed code-signing certificate works for
PPPC (MDM permission locking) before paying $99/year for an Apple
Developer ID. Run this at the **start** of Phase 2, before building the
full agent/daemon - the outcome decides the signing strategy (and
therefore the PKG build script, the PPPC profile, and Santa's rules) for
the entire rest of the project.

Takes about 15 minutes. Clear pass/fail gate; either outcome is a
complete answer, not a partial one.

## Before you start

- **Why this is worth testing rather than assuming**: TCC/PPPC's
  `CodeRequirement` matching is structural (does the running binary's
  actual signature satisfy the requirement string) - not inherently tied
  to who issued the certificate. Self-signed certs working here is a
  real, known technique, not a long shot. The one thing worth being
  honest about: exactly how this behaves can shift between macOS
  versions, and this hasn't been re-verified against every current
  release - which is the whole reason to test empirically here rather
  than assume either way.
- **Safety net for Test B** (which temporarily demotes your daily account
  to standard): the **admin account from Phase 0** is there specifically
  for this kind of situation. If anything goes wrong while your daily
  account is temporarily standard, log into that admin account and fix
  it from there rather than getting stuck.

## Step 1 - Create the self-signed certificate

Create a code-signing certificate in the login keychain using the
`security` CLI - not Keychain Access GUI, so this stays scriptable and
reproducible.

```bash
# Generate a self-signed code-signing certificate, valid 10 years
cat > /tmp/cert.cfg << 'EOF'
[ req ]
default_bits = 2048
prompt = no
distinguished_name = dn
x509_extensions = codesign

[ dn ]
CN = ContentGuard Signing
O = ContentGuard

[ codesign ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 \
  -keyout /tmp/cg-signing.key \
  -out /tmp/cg-signing.crt \
  -days 3650 -nodes \
  -config /tmp/cert.cfg

# Package as p12, import into the login keychain as an identity
openssl pkcs12 -export \
  -inkey /tmp/cg-signing.key \
  -in /tmp/cg-signing.crt \
  -out /tmp/cg-signing.p12 \
  -passout pass:temppass \
  -name "ContentGuard Signing"

security import /tmp/cg-signing.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -P temppass \
  -T /usr/bin/codesign

# Trust it for code signing
security add-trusted-cert -d -r trustRoot \
  -k ~/Library/Keychains/login.keychain-db \
  /tmp/cg-signing.crt

rm -f /tmp/cert.cfg /tmp/cg-signing.key /tmp/cg-signing.crt /tmp/cg-signing.p12

# Verify the identity exists
security find-identity -v -p codesigning
```

Expect something like `1) ABCDEF1234567890 "ContentGuard Signing"`. If
the identity appears, the certificate is ready.

## Step 2 - Build a minimal test app

Don't build the full blocker yet - just enough to request Screen
Recording and Accessibility.

```bash
mkdir -p ~/ContentGuardTest
```

`~/ContentGuardTest/main.swift`:

```swift
import Cocoa
import ScreenCaptureKit

@main
struct ContentGuardTest {
    static func main() async {
        print("ContentGuard PPPC Test")
        print("=====================")

        do {
            let content = try await SCShareableContent.current
            print("✅ Screen Recording: accessible (\(content.displays.count) displays found)")
        } catch {
            print("❌ Screen Recording: denied — \(error.localizedDescription)")
        }

        let axTrusted = AXIsProcessTrusted()
        if axTrusted {
            print("✅ Accessibility: trusted")
        } else {
            print("❌ Accessibility: not trusted")
        }

        print("\nRunning — check System Settings > Privacy & Security to see if permissions are MDM-managed.")
        print("Press Ctrl+C to exit.")
        RunLoop.main.run()
    }
}
```

`~/ContentGuardTest/Info.plist` — note the two usage-description keys
added beyond the original draft; missing these can cause flaky or
crash-y behavior specifically on Test B's interactive prompt path, which
would produce a false "fail" unrelated to the actual question being
tested:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.contentguard.test</string>
    <key>CFBundleName</key>
    <string>ContentGuardTest</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleExecutable</key>
    <string>ContentGuardTest</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>NSAccessibilityUsageDescription</key>
    <string>Testing PPPC-managed Accessibility access.</string>
    <key>NSScreenCaptureUsageDescription</key>
    <string>Testing PPPC-managed Screen Recording access.</string>
</dict>
</plist>
```

Build it:

```bash
cd ~/ContentGuardTest

swiftc main.swift -o ContentGuardTest \
  -framework Cocoa \
  -framework ScreenCaptureKit

mkdir -p ContentGuardTest.app/Contents/MacOS
cp ContentGuardTest ContentGuardTest.app/Contents/MacOS/
cp Info.plist ContentGuardTest.app/Contents/
```

## Step 3 - Sign the test app with the self-signed certificate

```bash
codesign --force --sign "ContentGuard Signing" \
  --options runtime \
  --deep \
  ~/ContentGuardTest/ContentGuardTest.app

codesign --verify --verbose ~/ContentGuardTest/ContentGuardTest.app

# THIS output line's content after "designated => " is the CodeRequirement for the PPPC profile
codesign --display -r - ~/ContentGuardTest/ContentGuardTest.app
```

Copy the full string after `designated => `.

## Step 4 - Generate and push the PPPC test profile

`~/ContentGuardTest/pppc-test.mobileconfig` - fresh UUIDs
(`python3 -c "import uuid; print(uuid.uuid4())"` works fine if `uuidgen`
isn't on hand), and the same `CodeRequirement` string pasted into both
`Accessibility` and `ScreenCapture` entries:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>PayloadDisplayName</key>
    <string>ContentGuard PPPC Test</string>
    <key>PayloadIdentifier</key>
    <string>com.contentguard.pppc.test</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>__GENERATE_UUID_1__</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadScope</key>
    <string>System</string>
    <key>PayloadRemovalDisallowed</key>
    <true/>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.TCC.configuration-profile-policy</string>
            <key>PayloadIdentifier</key>
            <string>com.contentguard.pppc.test.payload</string>
            <key>PayloadUUID</key>
            <string>__GENERATE_UUID_2__</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>Services</key>
            <dict>
                <key>Accessibility</key>
                <array>
                    <dict>
                        <key>Identifier</key>
                        <string>com.contentguard.test</string>
                        <key>IdentifierType</key>
                        <string>bundleID</string>
                        <key>CodeRequirement</key>
                        <string>__PASTE_CODE_REQUIREMENT_HERE__</string>
                        <key>Authorization</key>
                        <string>Allow</string>
                    </dict>
                </array>
                <key>ScreenCapture</key>
                <array>
                    <dict>
                        <key>Identifier</key>
                        <string>com.contentguard.test</string>
                        <key>IdentifierType</key>
                        <string>bundleID</string>
                        <key>CodeRequirement</key>
                        <string>__PASTE_CODE_REQUIREMENT_HERE__</string>
                        <key>Authorization</key>
                        <string>AllowStandardUserToSetSystemService</string>
                    </dict>
                </array>
            </dict>
        </dict>
    </array>
</dict>
</plist>
```

Push via Fleet: **Controls → OS settings → Configuration profiles →
Add profile**, upload this file. It should apply to the enrolled Mac
within a minute or so, same as the Phase 1 profiles.

## Step 5 - Run the tests (the pass/fail gate)

**Test A — Accessibility (silent grant)**

```bash
~/ContentGuardTest/ContentGuardTest.app/Contents/MacOS/ContentGuardTest
```

Look for `✅ Accessibility: trusted` **without ever clicking Allow**.
Also check **System Settings → Privacy & Security → Accessibility**:
ContentGuardTest should be listed, toggled on, and — the key
indicator — either greyed out/non-interactive or noted as
"managed by your organisation." That's the profile actually locking
the permission, not just granting it once.

**Test B — Screen Recording (standard-user approval)**

Screen Recording can't be silently granted (Apple limitation); the
`AllowStandardUserToSetSystemService` flag should let a standard user
approve it without admin credentials.

1. Log into the Phase 0 admin account.
2. System Settings → Users & Groups → change your daily account to
   Standard.
3. Log back into your daily account.
4. Run the test app - it should prompt for Screen Recording.
5. Click Allow - should succeed with **no admin credential prompt**.
6. `✅ Screen Recording: accessible` confirms it.

Afterward, promote your daily account back to admin the same way, in
reverse.

**Test C — Rebuild stability**

```bash
echo '// rebuild' >> ~/ContentGuardTest/main.swift
swiftc main.swift -o ContentGuardTest -framework Cocoa -framework ScreenCaptureKit
cp ContentGuardTest ContentGuardTest.app/Contents/MacOS/
codesign --force --sign "ContentGuard Signing" --options runtime --deep ContentGuardTest.app
codesign --display -r - ContentGuardTest.app
```

The designated requirement should be **identical** to Step 3's - same
cert, same requirement, regardless of rebuild. If it changed, self-signed
won't survive real-world rebuilds. Run the app again; permissions should
still be granted without re-approval.

## Step 6 - Evaluate

**All three pass** → self-signed works. Skip the Apple Developer ID,
save $99/year. Continue Phase 2 with this same certificate; the code
requirement from this test is what goes in the production
`profiles/pppc.mobileconfig` (just swap `com.contentguard.test` for the
real bundle ID, e.g. `com.contentguard.agent` - the `CodeRequirement`
itself stays the same, since it's bound to the certificate, not the
bundle ID).

Back it up:

```bash
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities \
  -f pkcs12 \
  -o ~/ContentGuardSigningBackup.p12 \
  -P "strong-backup-password"
```

Store that backup somewhere durable (vault-candidate) - losing the cert
means re-signing everything and re-pushing the PPPC profile from
scratch.

**Any test fails** → enrol in the Apple Developer Program ($99/year),
re-sign everything with the Developer ID instead.

## Step 7 - Clean up (either outcome)

```bash
# Remove the test profile from Fleet's UI (Controls > OS settings > Configuration profiles)

rm -rf ~/ContentGuardTest

# Only if self-signed FAILED and you're not keeping it:
# security delete-identity -c "ContentGuard Signing"
```
