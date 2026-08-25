import { tokens as T } from "../lib/tokens";
import { Card } from "../components/Card";
import { Note } from "../components/Note";
import { MdmProfileCard } from "../components/MdmProfileCard";
import { Loading, LoadError } from "../components/LoadState";
import { useMdm } from "../lib/useMdm";
import { Chrome as ChromeIcon } from "lucide-react";

// Filters the same real MDM profile list (see lib/useMdm.ts) down to the
// one profile whose real PayloadDisplayName is "ContentGuard Chrome
// Policy" - profiles/chrome-policy.mobileconfig. Not a separate data
// source, not per-rule toggles (see MdmProfileCard's own comment for
// why): this is the whole-profile ratchet, same as the Fleet MDM page,
// scoped to just this one file.
export function ChromePolicyPage() {
  const { rows, loading, error, fleet, fleetError, reload } = useMdm();
  const row = rows.find((r) => r.status.name === "ContentGuard Chrome Policy");

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Chrome policy</div>
      {loading && !fleet ? (
        <Loading />
      ) : !fleet ? (
        <LoadError message={fleetError || error || "Fleet not available"} onRetry={reload} />
      ) : !row ? (
        <div style={{ fontSize: 13, color: T.ink3, padding: "8px 0" }}>
          Fleet hasn't reported the "ContentGuard Chrome Policy" profile for this host yet.
        </div>
      ) : (
        <>
          <Note icon={ChromeIcon}>
            Force-installs the AI-blocker extension and locks it from removal via ExtensionInstallForcelist -
            everything else here (Developer tools, Incognito, other extension installs) exists to stop it being
            worked around.
          </Note>
          <MdmProfileCard row={row} onQueued={reload} />
        </>
      )}
    </Card>
  );
}
