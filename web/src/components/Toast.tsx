import { useEffect } from "react";
import { Check } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: T.forest,
        color: "#fff",
        padding: "12px 20px",
        borderRadius: 999,
        fontSize: 14,
        fontWeight: 600,
        fontFamily: F.body,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
      }}
    >
      <Check size={16} strokeWidth={2.8} color={T.bright} />
      {message}
    </div>
  );
}
