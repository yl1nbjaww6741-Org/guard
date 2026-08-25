import { Shield } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";
import type { NavItem } from "../lib/types";

export function Drawer({
  open,
  nav,
  current,
  onNav,
  onClose,
}: {
  open: boolean;
  nav: NavItem[];
  current: string;
  onNav: (id: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  let lastGroup: string | null = null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(14,15,12,0.35)" }} />
      <nav
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: 280,
          maxWidth: "80vw",
          background: T.surface,
          height: "100%",
          overflowY: "auto",
          boxShadow: "4px 0 24px rgba(0,0,0,0.10)",
          padding: "20px 0 40px",
          fontFamily: F.body,
        }}
      >
        <div
          style={{
            padding: "0 20px 18px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: `1px solid ${T.line}`,
          }}
        >
          <span
            style={{ width: 32, height: 32, borderRadius: 10, background: T.bright, display: "grid", placeItems: "center" }}
          >
            <Shield size={17} color={T.forest} strokeWidth={2.6} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em" }}>ContentGuard</div>
            <div style={{ fontSize: 11.5, color: T.ink3 }}>Central control panel</div>
          </div>
        </div>

        {nav.map((item) => {
          const showGroup = item.group && item.group !== lastGroup;
          lastGroup = item.group;
          const active = current === item.id;
          return (
            <div key={item.id}>
              {showGroup && (
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: T.ink3,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    padding: "18px 20px 6px",
                  }}
                >
                  {item.group}
                </div>
              )}
              {!item.group && item.id !== "home" && <div style={{ height: 8 }} />}
              <button
                onClick={() => {
                  onNav(item.id);
                  onClose();
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "10px 20px",
                  cursor: "pointer",
                  fontFamily: F.body,
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  color: active ? T.forest : T.ink2,
                  background: active ? T.mint : "transparent",
                  border: "none",
                  textAlign: "left",
                  borderRadius: 0,
                }}
              >
                <item.icon size={17} strokeWidth={active ? 2.5 : 2} color={active ? T.forest : T.ink3} />
                {item.label}
              </button>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
