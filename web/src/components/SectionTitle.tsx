import { tokens as T } from "../lib/tokens";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        color: T.ink3,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        margin: "18px 0 8px",
        padding: "0 2px",
      }}
    >
      {children}
    </div>
  );
}
