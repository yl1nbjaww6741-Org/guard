import { tokens as T } from "../lib/tokens";

export function Row({
  children,
  last,
  onClick,
  pad = "13px 0",
}: {
  children: React.ReactNode;
  last?: boolean;
  onClick?: () => void;
  pad?: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: pad,
        borderBottom: last ? "none" : `1px solid ${T.line}`,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {children}
    </div>
  );
}
