import { useRef, useState } from "react";
import { Check, AlertCircle } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";
import { Pill } from "./Pill";
import { timeUntil } from "../lib/time";
import * as api from "../lib/api";
import type { MdmProfileRow } from "../lib/useMdm";

const STATUS_TONE: Record<string, "mint" | "amber" | "rose" | "plain"> = {
  verified: "mint",
  verifying: "amber",
  pending: "amber",
  failed: "rose",
};

// One profile: Fleet's live status pill, the hand-kept restriction list
// (worker/src/configProfiles.ts's mirror), and a real update form - a
// whole-.mobileconfig-file replace through the ratchet (PATCH
// /api/config-profiles/:uuid, 24h delay + password), not a per-bullet
// toggle. There's no endpoint for toggling one restriction independently -
// this reflects that honestly rather than inventing per-row buttons for
// something the real backend can't do.
export function MdmProfileCard({ row, onQueued }: { row: MdmProfileRow; onQueued: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileRef.current?.files?.[0] || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("profile", fileRef.current.files[0]);
      fd.append("password", password);
      await api.updateConfigProfile(row.status.profile_uuid, fd);
      setPassword("");
      if (fileRef.current) fileRef.current.value = "";
      onQueued();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ borderBottom: `1px solid ${T.line}`, padding: "14px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Pill tone={STATUS_TONE[row.status.status] || "plain"} icon={row.status.status === "verified" ? Check : undefined}>
          {row.status.status}
        </Pill>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, flex: 1, minWidth: 0 }}>{row.status.name}</div>
      </div>

      {row.detail ? (
        <ul style={{ margin: "0 0 10px 1.2rem", padding: 0, fontSize: 12.5, color: T.ink2, lineHeight: 1.5 }}>
          {row.detail.restrictions.map((r, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {r}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 12.5, color: T.ink3, marginBottom: 10 }}>No local detail available for this profile.</div>
      )}

      {row.pendingChange ? (
        <div style={{ fontSize: 12.5, color: T.amberInk, background: T.amber, borderRadius: 10, padding: "8px 12px" }}>
          Update queued, applies in {timeUntil(row.pendingChange.applies_at)}
          {row.pendingChange.apply_error && " (last attempt failed, will retry)"}
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".mobileconfig" required style={{ fontSize: 12.5, fontFamily: F.body }} />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Office password"
            required
            style={{
              padding: "8px 12px", borderRadius: 10, border: `1.5px solid ${T.line2}`, background: T.page,
              fontSize: 12.5, color: T.ink, outline: "none", fontFamily: F.body, minWidth: 140,
            }}
          />
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "8px 14px", borderRadius: 999, cursor: submitting ? "default" : "pointer", border: "none",
              background: T.forest, color: "#fff", fontSize: 12.5, fontWeight: 700, fontFamily: F.body, opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Queuing…" : "Queue update (24h)"}
          </button>
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: T.roseInk, width: "100%" }}>
              <AlertCircle size={13} /> {error}
            </div>
          )}
        </form>
      )}
    </div>
  );
}
