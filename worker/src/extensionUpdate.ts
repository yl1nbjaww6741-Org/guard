// Serves the Chrome extension's self-hosted update manifest + packaged
// .crx for profiles/chrome-policy.mobileconfig's ExtensionInstallForcelist
// (see that file's own comment, and chrome-extension/build/README.md for
// how the .crx actually gets built and uploaded here). Unauthenticated
// by necessity, not oversight - Chrome's own extension update-check
// mechanism does a plain GET with no custom headers, so there's no
// realistic way to gate this the way every other route in this Worker
// is gated (same "some things this project's ratchet/session model just
// can't reach" reasoning already documented for direct Fleet pushes -
// see mac/docs/PHASE_4_DASHBOARD_SETUP.md). Accepted, not hidden: the
// packaged .crx itself carries no secret - the extension's own sync
// token is deliberately never baked into committed source (see
// chrome-extension/options/options.js's doc comment), so there's
// nothing sensitive in what a public fetch of this endpoint returns.

import type { Env } from "./types";

// MUST match chrome-extension/manifest.json's own "version" field
// exactly, and stay in sync with whatever .crx is currently uploaded to
// R2 (build/package-crx.sh's output) - Chrome compares this version
// against what's already installed and only fetches the .crx if this
// one is newer. Hand-kept, not read from the manifest at request time -
// same "no live channel between this Worker and the extension's own
// repo state" reasoning as staticSafeApps.ts/staticRules.ts's mirrors.
// BUMP THIS, and re-run build/package-crx.sh + re-upload to R2, every
// time chrome-extension/ actually changes - an unbumped version here
// means Chrome silently never re-checks for the new .crx at all.
const EXTENSION_VERSION = "0.2.1";

// Real, permanent extension ID - reported back after build/package-crx.sh
// was actually run (in the extension maintainer's own Codespace, not
// here - see that script's own header comment for why), the .crx
// uploaded to R2 with --remote (a first upload attempt without it
// silently wrote to the local Miniflare simulator instead, still
// printing "Upload complete" - real gotcha, now also fixed in
// build/README.md), and verified end-to-end with a real HTTPS GET
// against the live endpoint (200, content-type: application/x-chrome-
// extension, content-length byte-exact against the local file: 93339510).
const EXTENSION_ID = "pdhcmfmgdicpkanpigjpgenhhbbollpk";

function updateManifestXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXTENSION_ID}">
    <updatecheck codebase="${origin}/extension/contentguard.crx" version="${EXTENSION_VERSION}" />
  </app>
</gupdate>`;
}

export function handleExtensionUpdateManifest(request: Request): Response {
  const url = new URL(request.url);
  return new Response(updateManifestXml(url.origin), {
    headers: { "content-type": "application/xml" },
  });
}

// Streams the actual .crx straight from R2 - see wrangler.toml's
// [[r2_buckets]] binding and chrome-extension/build/README.md for how it
// gets uploaded there (`wrangler r2 object put`, never something this
// Worker writes itself - this route is read-only).
export async function handleExtensionCrx(env: Env): Promise<Response> {
  const object = await env.EXTENSION_ASSETS?.get("contentguard.crx");
  if (!object) {
    return new Response(
      "Extension package not uploaded yet - see chrome-extension/build/README.md",
      { status: 404 }
    );
  }
  return new Response(object.body, {
    headers: {
      // application/x-chrome-extension, not application/octet-stream -
      // crx3's own README specifically calls this out as needed for
      // Chrome to reliably recognize and apply a self-hosted update.
      "content-type": "application/x-chrome-extension",
      "content-length": String(object.size),
    },
  });
}
