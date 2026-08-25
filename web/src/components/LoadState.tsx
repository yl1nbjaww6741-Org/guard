import { RefreshCw, AlertCircle } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";

// Loading/error states shared by every real-data page - the prototype
// had neither (mock data resolves instantly, synchronously); this is
// exactly the "Loading spinners, error messages, retry" gap
// DASHBOARD-PROMPT.md's own prototype-to-production table calls out.
export function Loading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "40px 0",
        color: T.ink3,
        fontSize: 14,
        fontFamily: F.body,
      }}
    >
      <RefreshCw size={16} className="cg-spin" strokeWidth={2.2} />
      Loading…
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: T.rose,
        borderRadius: 14,
        padding: "13px 15px",
        alignItems: "flex-start",
        fontFamily: F.body,
      }}
    >
      <AlertCircle size={16} color={T.roseInk} strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, fontSize: 13.5, color: T.roseInk, lineHeight: 1.45 }}>
        Couldn't load this: {message}
        <button
          onClick={onRetry}
          style={{
            display: "block",
            marginTop: 8,
            background: "none",
            border: `1.5px solid ${T.roseInk}`,
            color: T.roseInk,
            borderRadius: 999,
            padding: "5px 12px",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: F.body,
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
