import { useState } from "react";
import { tokens as T, font as F } from "../lib/tokens";
import { Card } from "../components/Card";
import { Note } from "../components/Note";
import { Pill } from "../components/Pill";
import { useLoad } from "../lib/useLoad";
import { timeUntil } from "../lib/time";
import * as api from "../lib/api";
import { KeyRound, Clock } from "lucide-react";

function PasswordForm({
  onSubmit,
  submitLabel,
  currentLabel,
  newLabel,
}: {
  onSubmit: (current: string, next: string) => Promise<void>;
  submitLabel: string;
  currentLabel: string;
  newLabel: string;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      await onSubmit(current, next);
      setCurrent("");
      setNext("");
      setStatus({ ok: true, message: "Done." });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    flex: 1,
    minWidth: 160,
    boxSizing: "border-box" as const,
    padding: "12px 14px",
    borderRadius: 12,
    border: `1.5px solid ${T.line2}`,
    background: T.page,
    fontSize: 14,
    color: T.ink,
    outline: "none",
    fontFamily: F.body,
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder={currentLabel} required style={inputStyle} />
      <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={newLabel} required style={inputStyle} />
      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: "12px 18px", borderRadius: 999, cursor: submitting ? "default" : "pointer", border: "none",
          background: T.forest, color: "#fff", fontSize: 13.5, fontWeight: 700, fontFamily: F.body, opacity: submitting ? 0.6 : 1,
        }}
      >
        {submitting ? "Working…" : submitLabel}
      </button>
      {status && (
        <div style={{ width: "100%", fontSize: 13, color: status.ok ? T.mintInk : T.roseInk }}>{status.message}</div>
      )}
    </form>
  );
}

export function ChangePasswordPage() {
  const pendingOffice = useLoad(api.getPendingOfficePasswordChange);

  return (
    <>
      <Card style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Change login password</div>
        <Note icon={KeyRound}>
          The everyday credential that gets you into this dashboard at all, and lets you view/tighten once you're
          in. Takes effect immediately - it doesn't loosen or tighten anything on its own.
        </Note>
        <PasswordForm
          submitLabel="Change now"
          currentLabel="Current login password"
          newLabel="New login password"
          onSubmit={(current, next) => api.changeLoginPassword(current, next)}
        />
      </Card>

      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Change office password</div>
        <Note icon={Clock} tone="amber">
          The one that unlocks loosening - required to un-block a Santa rule, add a safe app, or edit an MDM
          profile. Changing it still goes through the same 24h delay as every other loosening action.
        </Note>
        {pendingOffice.data ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Pill tone="amber" icon={Clock}>
              Change queued, applies in {timeUntil(pendingOffice.data.applies_at)}
            </Pill>
            <button
              onClick={async () => {
                await api.cancelOfficePasswordChange(pendingOffice.data!.id);
                pendingOffice.reload();
              }}
              style={{ background: "none", border: "none", color: T.ink3, fontSize: 12.5, cursor: "pointer", textDecoration: "underline", fontFamily: F.body }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <PasswordForm
            submitLabel="Request change"
            currentLabel="Current office password"
            newLabel="New office password"
            onSubmit={async (current, next) => {
              await api.requestOfficePasswordChange(current, next);
              pendingOffice.reload();
            }}
          />
        )}
      </Card>
    </>
  );
}
