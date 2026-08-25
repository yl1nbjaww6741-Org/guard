import { tokens as T, font as F } from "../lib/tokens";

export function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div style={{ background: T.page, borderRadius: 12, padding: "12px 14px" }}>
      <div
        style={{
          fontSize: 11,
          color: T.ink3,
          fontWeight: 600,
          letterSpacing: "0.02em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          marginTop: 4,
          fontFamily: F.mono,
          letterSpacing: "-0.02em",
          color: good ? T.mintInk : T.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}
