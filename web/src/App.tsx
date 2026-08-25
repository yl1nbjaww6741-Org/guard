import { useCallback, useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { tokens as T, font as F } from "./lib/tokens";
import { NAV } from "./lib/nav";
import { Drawer } from "./components/Drawer";
import { Pill } from "./components/Pill";
import { Toast } from "./components/Toast";
import { VaultSheet, type VaultRequest } from "./components/VaultSheet";
import { LoginPage } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { FleetPage } from "./pages/Fleet";
import { SantaPage } from "./pages/Santa";
import { RestrictionsPage } from "./pages/Restrictions";
import { ChromePolicyPage } from "./pages/ChromePolicy";
import { ChangePasswordPage } from "./pages/ChangePassword";
import * as api from "./lib/api";

export default function App() {
  // Optimistic: assume a session exists until a real request proves
  // otherwise (401 -> api.onUnauthorized below). There's no cheap
  // "am I logged in" endpoint to check first - the first real page's own
  // data fetch doubles as that check, same request either way.
  const [authenticated, setAuthenticated] = useState(true);
  const [page, setPage] = useState("home");
  const [drawer, setDrawer] = useState(false);
  const [vaultRequest, setVaultRequest] = useState<VaultRequest | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useEffect(() => {
    api.onUnauthorized(() => setAuthenticated(false));
  }, []);

  const askVault = useCallback((request: VaultRequest) => setVaultRequest(request), []);
  const toast = useCallback((message: string) => setToastMsg(message), []);

  if (!authenticated) {
    return <LoginPage onLoggedIn={() => setAuthenticated(true)} />;
  }

  const current = NAV.find((n) => n.id === page);
  const pageTitle = current ? current.label : "Home";

  return (
    <div style={{ background: T.page, minHeight: "100vh", fontFamily: F.body, color: T.ink }}>
      <header
        style={{
          background: T.surface,
          borderBottom: `1px solid ${T.line}`,
          padding: "0 16px",
          position: "sticky",
          top: 0,
          zIndex: 30,
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button onClick={() => setDrawer(true)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "grid", placeItems: "center" }}>
          <Menu size={22} color={T.ink} strokeWidth={2.2} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 16, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {pageTitle}
          </div>
        </div>
        <button
          onClick={async () => {
            await api.logout().catch(() => {});
            setAuthenticated(false);
          }}
          style={{ background: "none", border: "none", cursor: "pointer" }}
        >
          <Pill tone="plain">Log out</Pill>
        </button>
      </header>

      <Drawer open={drawer} nav={NAV} current={page} onNav={setPage} onClose={() => setDrawer(false)} />

      <main style={{ maxWidth: 620, margin: "0 auto", padding: "14px 12px 50px" }}>
        {page === "home" && <HomePage />}
        {page === "fleet" && <FleetPage />}
        {page === "santa" && <SantaPage askVault={askVault} toast={toast} />}
        {page === "restrict" && <RestrictionsPage askVault={askVault} toast={toast} />}
        {page === "chrome" && <ChromePolicyPage />}
        {page === "password" && <ChangePasswordPage />}
      </main>

      {vaultRequest && <VaultSheet request={vaultRequest} onClose={() => setVaultRequest(null)} />}
      {toastMsg && <Toast message={toastMsg} onDone={() => setToastMsg(null)} />}
    </div>
  );
}
