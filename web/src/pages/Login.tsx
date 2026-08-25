import { useState } from "react";
import { Shield } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";
import * as api from "../lib/api";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        background: T.page,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: F.body,
        padding: 20,
      }}
    >
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: T.bright, display: "grid", placeItems: "center" }}>
            <Shield size={21} color={T.forest} strokeWidth={2.6} />
          </span>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em" }}>ContentGuard Central</div>
        </div>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Login password"
            required
            style={{
              padding: "14px 16px", borderRadius: 12, border: `1.5px solid ${T.line2}`, background: T.surface,
              fontSize: 15, color: T.ink, outline: "none", fontFamily: F.body,
            }}
          />
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "14px 16px", borderRadius: 999, cursor: submitting ? "default" : "pointer", border: "none",
              background: T.bright, color: T.forest, fontSize: 15, fontWeight: 700, fontFamily: F.body, opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Logging in…" : "Log in"}
          </button>
          {error && <div style={{ fontSize: 13.5, color: T.roseInk }}>{error}</div>}
        </form>
      </div>
    </div>
  );
}
