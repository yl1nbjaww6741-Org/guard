// Wise light design tokens - matches DASHBOARD-PROMPT.md's spec exactly,
// and the ContentGuardCentral.jsx prototype's own `T`/`F`/`M` constants.
// Kept as one small module rather than inlined per-component, so a
// future design tweak (a token value change) only needs one edit.

export const tokens = {
  bright: "#9FE870", // Primary action - tighten buttons
  forest: "#163300", // Primary dark - loosen buttons, active nav, hero backgrounds
  ink: "#0E0F0C", // Primary text
  ink2: "#454745", // Secondary text
  ink3: "#6A6C6A", // Tertiary text
  page: "#F2F3F0", // Page background
  surface: "#FFFFFF", // Card background
  line: "#EAECE6", // Hairline borders
  line2: "#DFE1DB", // Heavier borders (inputs, sheet handle)
  mint: "#E8F5D0", // Positive tint (on, healthy, pass)
  mintInk: "#2F5711", // Positive text
  amber: "#FFF4CC", // Caution tint (pending, time-locked)
  amberInk: "#7A5B00", // Caution text
  rose: "#FFE9E5", // Negative tint (blocked, failed)
  roseInk: "#A8200D", // Negative text
  blue: "#E3EEFF", // Info tint (forced, managed)
  blueInk: "#1A4B99", // Info text
} as const;

export const font = {
  body: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Roboto Mono', monospace",
} as const;

export type PillTone = "mint" | "amber" | "rose" | "plain" | "blue";
export type NoteTone = "mint" | "amber" | "rose";
