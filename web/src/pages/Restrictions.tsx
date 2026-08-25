import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";
import { Card } from "../components/Card";
import { Row } from "../components/Row";
import { Pill } from "../components/Pill";
import { Note } from "../components/Note";
import { SectionTitle } from "../components/SectionTitle";
import { Loading, LoadError } from "../components/LoadState";
import { useLoad } from "../lib/useLoad";
import { timeAgo, timeUntil } from "../lib/time";
import * as api from "../lib/api";
import type { VaultRequest } from "../components/VaultSheet";

// "Restrictions" here = the safe-apps (screen-capture scan exemption)
// list - the closest real match to DASHBOARD-PROMPT.md's "macOS
// restrictions" page, since there's no per-toggle endpoint for the
// MDM-level restrictions (AirDrop, screenshots, etc.) - those are whole-
// profile uploads, covered on the Fleet MDM page instead. Opposite
// ratchet polarity from Santa: adding an exemption loosens (vault),
// removing one tightens (immediate) - matches db.ts's own comment on
// safe_app_bundle_ids exactly.
export function RestrictionsPage({
  askVault,
  toast,
}: {
  askVault: (request: VaultRequest) => void;
  toast: (message: string) => void;
}) {
  const staticApps = useLoad(api.getStaticSafeApps);
  const approved = useLoad(api.getSafeApps);
  const pending = useLoad(api.getSafeAppAdditions);
  const [bundleId, setBundleId] = useState("");
  const [name, setName] = useState("");

  const loaded = staticApps.data && approved.data && pending.data;
  const error = staticApps.error || approved.error || pending.error;

  const reload = () => {
    approved.reload();
    pending.reload();
  };

  const remove = async (id: string) => {
    try {
      await api.removeSafeApp(id);
      toast(`Removed ${id} from the safe-app list.`);
      reload();
    } catch (err) {
      toast(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const cancel = async (id: number) => {
    await api.cancelSafeAppAddition(id);
    pending.reload();
  };

  const requestAdd = () => {
    if (!bundleId) return;
    askVault({
      action: `add ${name || bundleId} to the safe-app list (stops screen-capture scanning it)`,
      onSubmit: async (password) => {
        await api.requestAddSafeApp(bundleId, name || undefined, password);
        setBundleId("");
        setName("");
        reload();
      },
    });
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Restrictions — safe apps</div>
      <Note icon={ArrowUp} tone="amber">
        Every bundle ID here is excluded from ContentGuardDaemon's screen-capture scanning - a real blind spot,
        kept short and deliberate. Adding one loosens the setup (office password, 24h); removing one tightens it
        immediately.
      </Note>

      {!loaded && !error ? (
        <Loading />
      ) : error && !loaded ? (
        <LoadError message={error} onRetry={reload} />
      ) : (
        <>
          <SectionTitle>Compiled baseline (permanent, from Config.swift)</SectionTitle>
          {(staticApps.data || []).map((a, i, arr) => (
            <Row key={a.bundleId} last={i === arr.length - 1}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{a.name}</div>
                <div style={{ fontSize: 12, color: T.ink3, marginTop: 1, fontFamily: F.mono }}>{a.bundleId}</div>
              </div>
              <Pill tone="plain">Compiled in</Pill>
            </Row>
          ))}

          <SectionTitle>Dashboard-approved · {(approved.data || []).length}</SectionTitle>
          {(approved.data || []).length === 0 ? (
            <div style={{ fontSize: 13, color: T.ink3, padding: "8px 0" }}>None added from the dashboard.</div>
          ) : (
            (approved.data || []).map((a, i, arr) => (
              <Row key={a.bundle_id} last={i === arr.length - 1}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{a.name || "unknown"}</div>
                  <div style={{ fontSize: 12, color: T.ink3, marginTop: 1, fontFamily: F.mono }}>
                    {a.bundle_id} · added {timeAgo(a.added_at)}
                  </div>
                </div>
                <button
                  onClick={() => remove(a.bundle_id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: T.bright,
                    color: T.forest, border: "none", borderRadius: 999, padding: "7px 13px", fontSize: 12.5,
                    fontWeight: 700, cursor: "pointer", fontFamily: F.body,
                  }}
                >
                  <ArrowUp size={12} strokeWidth={3} /> Remove
                </button>
              </Row>
            ))
          )}

          {(pending.data || []).length > 0 && (
            <>
              <SectionTitle>Pending additions</SectionTitle>
              {(pending.data || []).map((p, i, arr) => (
                <Row key={p.id} last={i === arr.length - 1}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: T.ink2 }}>{p.name || p.bundle_id}</div>
                  <Pill tone="amber">{timeUntil(p.applies_at)}</Pill>
                  <button
                    onClick={() => cancel(p.id)}
                    style={{ background: "none", border: "none", color: T.ink3, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: F.body, marginLeft: 8 }}
                  >
                    Cancel
                  </button>
                </Row>
              ))}
            </>
          )}

          <SectionTitle>Add an exemption</SectionTitle>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="Bundle ID (e.g. com.google.Chrome)"
              style={{
                flex: 2, minWidth: 200, boxSizing: "border-box", padding: "12px 14px", borderRadius: 12,
                border: `1.5px solid ${T.line2}`, background: T.page, fontSize: 14, color: T.ink, outline: "none", fontFamily: F.body,
              }}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="App name (optional)"
              style={{
                flex: 1, minWidth: 140, boxSizing: "border-box", padding: "12px 14px", borderRadius: 12,
                border: `1.5px solid ${T.line2}`, background: T.page, fontSize: 14, color: T.ink, outline: "none", fontFamily: F.body,
              }}
            />
            <button
              onClick={requestAdd}
              disabled={!bundleId}
              style={{
                padding: "12px 18px", borderRadius: 999, cursor: bundleId ? "pointer" : "default", border: "none",
                background: T.forest, color: "#fff", fontSize: 13.5, fontWeight: 700, fontFamily: F.body,
                opacity: bundleId ? 1 : 0.5,
              }}
            >
              Request add
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
