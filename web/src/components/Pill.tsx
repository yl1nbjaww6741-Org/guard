import type { LucideIcon } from "lucide-react";
import type { PillTone } from "../lib/tokens";
import { tokens as T } from "../lib/tokens";

const TONE_MAP: Record<PillTone, { bg: string; fg: string }> = {
  mint: { bg: T.mint, fg: T.mintInk },
  amber: { bg: T.amber, fg: T.amberInk },
  rose: { bg: T.rose, fg: T.roseInk },
  plain: { bg: T.line, fg: T.ink2 },
  blue: { bg: T.blue, fg: T.blueInk },
};

export function Pill({
  tone = "mint",
  children,
  icon: Icon,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  icon?: LucideIcon;
}) {
  const m = TONE_MAP[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        background: m.bg,
        color: m.fg,
        borderRadius: 999,
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {Icon && <Icon size={12} strokeWidth={2.5} />}
      {children}
    </span>
  );
}
