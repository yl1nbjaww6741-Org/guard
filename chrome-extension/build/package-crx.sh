#!/usr/bin/env bash
# Packages chrome-extension/ into a signed CRX3, for MDM force-install
# hosting (profiles/chrome-policy.mobileconfig's ExtensionInstallForcelist,
# see that file's own comment). Run this yourself, in your own Codespace -
# NOT something to hand to an assistant to run remotely. The private key
# this generates on first run is a permanent credential: losing it means
# publishing any future update requires a NEW extension ID (breaking the
# MDM policy's forcelist entry and every install already using the old
# one); leaking it means someone else could sign an "update" Chrome would
# trust as legitimate, IF they could also get it served from your own
# panel.lukep009.download domain. See build/README.md for the full setup
# walkthrough (uploading the output to R2, telling the extension ID to
# whoever maintains chrome-policy.mobileconfig).
#
# Output lands in build/dist/ (gitignored - see chrome-extension/.gitignore).
# The private key (build/dist/key.pem) is REUSED on every run after the
# first (crx3 only generates a new one if the file doesn't already
# exist) - back it up somewhere outside this repo, since deleting it
# accidentally is exactly the "publish under a new ID" scenario above.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EXTENSION_URL="${EXTENSION_URL:-https://panel.lukep009.download/extension/contentguard.crx}"
APP_VERSION="$(node -pe "require('./manifest.json').version")"

echo "Packaging chrome-extension/ (version $APP_VERSION) ..."

# Real bug, found live (2026-09-03): this used to be `rm -rf build/dist`
# (the whole directory) - which deletes key.pem along with the staging
# copy, EVERY run, before crx3 ever gets a chance to check "does it
# already exist, reuse it." That directly contradicts this file's own
# header comment ("REUSED on every run after the first") and is the
# actual reason the extension ID kept changing on every re-package
# attempt, even with a real backed-up key.pem restored to
# build/dist/key.pem beforehand - restoring it there and then running
# this script used to delete it right back out from under itself. Only
# the staging src/ copy needs a clean wipe each run; key.pem (and the
# previous .crx/update.xml, harmless to regenerate) must survive.
rm -rf build/dist/src
mkdir -p build/dist/src

# -L dereferences model/nudenet_640m.onnx's symlink (see manifest's own
# comment on why that's a symlink, not a second copy) - a CRX/ZIP package
# needs real file content, not a link pointing outside the package.
# content-scripts/ and options/ re-added to this list 2026-09-04 along
# with keyword blocking itself (see git history: they were dropped from
# here when 30a332e removed keyword blocking entirely, then the feature
# was reintroduced) - every directory manifest.json actually references
# needs to be listed here explicitly, this script doesn't infer it from
# the manifest.
cp -RL background content-scripts lib model options sandbox manifest.json build/dist/src/

npx --yes crx3@2.0.0 \
  -p build/dist/key.pem \
  -o build/dist/contentguard.crx \
  -x build/dist/update.xml \
  --appVersion "$APP_VERSION" \
  --crxURL "$EXTENSION_URL" \
  -- build/dist/src

echo ""
echo "Done. Output in build/dist/:"
ls -lh build/dist/*.crx build/dist/*.pem build/dist/*.xml
echo ""
echo "Extension ID (from build/dist/update.xml's appid):"
grep -o 'appid="[^"]*"' build/dist/update.xml
echo ""
echo "Next steps - see build/README.md:"
echo "  1. Back up build/dist/key.pem somewhere safe, OUTSIDE this repo."
echo "  2. Upload build/dist/contentguard.crx to R2 (command in build/README.md)."
echo "  3. Report the extension ID above so it can go into"
echo "     profiles/chrome-policy.mobileconfig's ExtensionInstallForcelist."
