import type { CSSProperties } from "react";
import { tokens as T } from "../lib/tokens";

export function Card({
  children,
  style,
  dark,
}: {
  children: React.ReactNode;
  style?: CSSProperties;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        background: dark ? T.forest : T.surface,
        border: dark ? "none" : `1px solid ${T.line}`,
        borderRadius: 16,
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
