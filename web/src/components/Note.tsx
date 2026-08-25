import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import type { NoteTone } from "../lib/tokens";
import { tokens as T } from "../lib/tokens";

const TONE_MAP: Record<NoteTone, { bg: string; fg: string }> = {
  mint: { bg: T.mint, fg: T.mintInk },
  amber: { bg: T.amber, fg: T.amberInk },
  rose: { bg: T.rose, fg: T.roseInk },
};

export function Note({
  icon: Icon,
  children,
  tone = "mint",
  style,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  tone?: NoteTone;
  style?: CSSProperties;
}) {
  const m = TONE_MAP[tone];
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: m.bg,
        borderRadius: 14,
        padding: "13px 15px",
        margin: "0 0 14px",
        alignItems: "flex-start",
        ...style,
      }}
    >
      <Icon size={16} color={m.fg} strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13.5, color: m.fg, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
}
