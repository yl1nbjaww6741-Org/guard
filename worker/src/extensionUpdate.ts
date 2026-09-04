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
// packaged .crx itself carries no secret - there's no sync token at all
// any more (extensionSync.ts's GET /sync/keywords is unauthenticated by
// the same design choice, see that file's own doc comment), so there's
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
const EXTENSION_VERSION = "0.4.1";

// Real, permanent extension ID - re-keyed 2026-09-04. The ORIGINAL ID
// (pdhcmfmgdicpkanpigjpgenhhbbollpk, live since 2026-08-25) got silently
// blocked by Chrome's own built-in Safe Browsing extension blocklist -
// NOT this project's own MDM policy (confirmed absent from a real
// chrome://policy read), NOT a bug in this Worker or the .crx itself
// (the file was confirmed correctly served, byte-exact, right up to the
// point Chrome refused to load it: chrome-extension://<old-id>/manifest.json
// returned Chrome's own native "<id> is blocked / This page has been
// blocked by Chrome" page, while the identical test against a known-good,
// currently-installed extension's ID loaded its manifest.json fine -
// isolating the block to specifically the old ID, not a general Chrome
// behavior). Worked fine through 0.2.0/0.3.1/0.4.0's real installs, then
// stopped working on this same ID for 0.4.1 with no code change of its
// own - most likely explanation: the extension's own real runtime
// behavior (silently capturing the screen every few seconds, auto-
// closing tabs on a classifier's verdict) reads exactly like a spyware/
// screen-recorder heuristic, and it took some real running time after
// the 0.4.0 install for Google's own telemetry to flag the ID - not
// something a version bump or a re-upload could ever have fixed, since
// the ID itself was the thing blocked.
//
// Re-keyed by generating a fresh key.pem (build/package-crx.sh reuses
// key.pem if present, so getting a new ID means moving the old one
// aside first - see build/README.md) - same re-verification steps as
// the original: .crx uploaded to R2 with --remote, confirmed via a real
// HTTPS GET against the live endpoint. This resets the clock, not a
// permanent fix - the same behavior pattern could get THIS id flagged
// again eventually too, a real, accepted risk of self-hosting a
// screen-capturing extension outside the Chrome Web Store's own review
// process.
const EXTENSION_ID = "ofcbfgalhkhmpknpkcnefgffdhecdjba";

function updateManifestXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXTENSION_ID}">
    <updatecheck codebase="${origin}/extension/contentguard.crx" version="${EXTENSION_VERSION}" />
  </app>
</gupdate>`;
}

// HEAD support (index.ts routes both here) matters beyond spec
// correctness for its own sake: chrome-extension/build/README.md's own
// documented verification step is `curl -sI` against this endpoint - a
// HEAD request - so a HEAD-less version of this handler would make that
// exact recommended check falsely report "not there" even when a real
// GET works fine (found live, 2026-09-04). A HEAD response carries the
// same headers as GET but no body, per HTTP's own definition.
export function handleExtensionUpdateManifest(request: Request): Response {
  const url = new URL(request.url);
  const xml = updateManifestXml(url.origin);
  return new Response(request.method === "HEAD" ? null : xml, {
    headers: {
      "content-type": "application/xml",
      "content-length": String(xml.length),
    },
  });
}

// Streams the actual .crx straight from R2 - see wrangler.toml's
// [[r2_buckets]] binding and chrome-extension/build/README.md for how it
// gets uploaded there (`wrangler r2 object put`, never something this
// Worker writes itself - this route is read-only).
//
// `method` distinguishes GET from HEAD (see this file's top-of-block
// comment above) - a HEAD request uses R2's own head() rather than
// get(), so verifying the upload landed doesn't mean transferring the
// full ~90MB object (this .crx bundles the NudeNet ONNX model, not a
// typical small extension) just to discard the body.
export async function handleExtensionCrx(env: Env, method: string): Promise<Response> {
  const object =
    method === "HEAD"
      ? await env.EXTENSION_ASSETS?.head("contentguard.crx")
      : await env.EXTENSION_ASSETS?.get("contentguard.crx");
  if (!object) {
    return new Response(
      "Extension package not uploaded yet - see chrome-extension/build/README.md",
      { status: 404 }
    );
  }
  const headers = {
    // application/x-chrome-extension, not application/octet-stream -
    // crx3's own README specifically calls this out as needed for
    // Chrome to reliably recognize and apply a self-hosted update.
    "content-type": "application/x-chrome-extension",
    "content-length": String(object.size),
  };
  // Only an R2ObjectBody (the get() result) has a readable .body -
  // head() returns metadata only (R2Object), nothing to stream even if
  // this weren't already a HEAD response.
  return new Response(method === "HEAD" ? null : (object as R2ObjectBody).body, { headers });
}
