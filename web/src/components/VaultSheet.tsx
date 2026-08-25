import { useState } from "react";
import { KeyRound, Clock, AlertCircle } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";

export interface VaultRequest {
  action: string;
  onSubmit: (password: string) => Promise<void>;
}

// Same visual shape as the prototype, made functional: collects the
// office password and calls the caller's onSubmit (a real
// request*/requestAddSafeApp/requestLoosenRule/etc. call from lib/api.ts),
// shows the real error if the Worker rejects it (wrong password, already
// pending, etc.) instead of always silently succeeding.
export function VaultSheet({ request, onClose }: { request: VaultRequest; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      await request.onSubmit(password);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={submitting ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(14,15,12,0.5)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.surface,
          width: "100%",
          maxWidth: 520,
          borderRadius: "24px 24px 0 0",
          padding: "10px 20px 32px",
          fontFamily: F.body,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line2, margin: "0 auto 20px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 14,
              background: T.amber,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <KeyRound size={21} color={T.amberInk} strokeWidth={2.2} />
          </span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em" }}>
              This loosens your setup
            </div>
            <div style={{ fontSize: 13.5, color: T.ink3, marginTop: 2 }}>Office password, then a 24-hour wait</div>
          </div>
        </div>

        <div
          style={{
            background: T.page,
            borderRadius: 14,
            padding: "15px 17px",
            fontSize: 14,
            color: T.ink2,
            lineHeight: 1.55,
            marginBottom: 18,
          }}
        >
          You're asking to <strong style={{ color: T.ink }}>{request.action}</strong>. Tightening happens the moment
          you tap. Loosening goes through the office password and a delay you can't shorten.
        </div>

        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: T.ink2, marginBottom: 7 }}>
          Office password
        </label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={submitting}
          placeholder="The one kept out of easy reach"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 16px",
            borderRadius: 12,
            border: `1.5px solid ${error ? T.roseInk : T.line2}`,
            background: T.surface,
            fontSize: 15,
            color: T.ink,
            outline: "none",
            fontFamily: F.body,
            marginBottom: error ? 10 : 18,
          }}
        />

        {error && (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              background: T.rose,
              borderRadius: 12,
              padding: "10px 13px",
              marginBottom: 18,
            }}
          >
            <AlertCircle size={15} color={T.roseInk} strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, color: T.roseInk, lineHeight: 1.4 }}>{error}</div>
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "flex-start",
            background: T.amber,
            borderRadius: 14,
            padding: "14px 16px",
            marginBottom: 22,
          }}
        >
          <Clock size={18} color={T.amberInk} strokeWidth={2.3} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13.5, color: T.amberInk, lineHeight: 1.45 }}>
            <strong>Takes effect in 24 hours.</strong> The countdown runs on Cloudflare, not this device - changing
            the local clock does nothing. You can cancel at any point before it applies.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onClose}
            disabled={submitting}
            style={{
              flex: 1,
              padding: "15px 18px",
              borderRadius: 999,
              cursor: submitting ? "default" : "pointer",
              border: `1.5px solid ${T.line2}`,
              background: T.surface,
              fontSize: 15,
              fontWeight: 700,
              color: T.ink,
              fontFamily: F.body,
              opacity: submitting ? 0.6 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !password}
            style={{
              flex: 1.4,
              padding: "15px 18px",
              borderRadius: 999,
              cursor: submitting || !password ? "default" : "pointer",
              border: "none",
              background: T.bright,
              color: T.forest,
              fontSize: 15,
              fontWeight: 700,
              fontFamily: F.body,
              opacity: submitting || !password ? 0.6 : 1,
            }}
          >
            {submitting ? "Starting…" : "Start the wait"}
          </button>
        </div>
      </div>
    </div>
  );
}
