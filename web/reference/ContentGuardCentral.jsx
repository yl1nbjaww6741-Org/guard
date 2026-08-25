import { useState, useEffect, useCallback } from "react";
import {
  Shield, Globe, Monitor, Smartphone, KeyRound, Lock, Check, X,
  ChevronRight, Clock, ArrowUp, ArrowDown, Wifi, Menu,
  AppWindow, Eye, HardDrive, Chrome, Cpu, Activity, Server,
  AlertCircle, Search, RefreshCw, Bell, ChevronDown, Fingerprint,
  Settings, Zap, Radio, Router, Ban, FileKey, ShieldCheck,
  MonitorSmartphone, Terminal, ExternalLink, CircleDot,
} from "lucide-react";

/* ── Wise light tokens ───────────────────────────── */
const T = {
  bright: "#9FE870", forest: "#163300", ink: "#0E0F0C",
  ink2: "#454745", ink3: "#6A6C6A", page: "#F2F3F0",
  surface: "#FFFFFF", line: "#EAECE6", line2: "#DFE1DB",
  mint: "#E8F5D0", mintInk: "#2F5711",
  amber: "#FFF4CC", amberInk: "#7A5B00",
  rose: "#FFE9E5", roseInk: "#A8200D",
  blue: "#E3EEFF", blueInk: "#1A4B99",
};
const F = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif";
const M = "ui-monospace, 'SF Mono', 'Roboto Mono', monospace";

/* ── Data model ──────────────────────────────────── */
const initGateway = [
  { id: "adult", name: "Adult and pornography", on: true },
  { id: "nudity", name: "Nudity", on: true },
  { id: "gamble", name: "Gambling", on: true },
  { id: "malware", name: "Malware and phishing", on: true },
  { id: "anon", name: "Anonymisers and proxies", on: true },
  { id: "drugs", name: "Drugs", on: true },
  { id: "weapons", name: "Weapons", on: true },
  { id: "dating", name: "Dating", on: true },
  { id: "social", name: "Social media", on: false },
  { id: "stream", name: "Streaming media", on: false },
  { id: "gaming", name: "Online gaming", on: false },
];

const initBypass = [
  { id: "relay", name: "iCloud Private Relay", on: true, why: "Routes traffic around WARP through Apple's relay servers" },
  { id: "doh", name: "Chrome's built-in DNS", on: true, why: "Would let Chrome resolve names outside your Gateway filter" },
  { id: "vpn", name: "Personal VPN profiles", on: true, why: "Would create a tunnel that bypasses WARP entirely" },
  { id: "proxy", name: "Proxy configuration", on: true, why: "Would route traffic outside the tunnel" },
  { id: "dns_lock", name: "DNS pinned to Gateway", on: true, why: "System resolver locked to your Cloudflare DoH endpoint" },
];

const initUnifi = [
  { id: "cf", name: "Content filtering", on: true, why: "Router-level adult/malware category blocking" },
  { id: "dnsr", name: "DNS redirect to Gateway", on: true, why: "Forces every client on the network through Cloudflare" },
  { id: "iot", name: "IoT network isolation", on: true, why: "Smart devices can't reach the main network" },
  { id: "guest", name: "Guest network", on: false, why: "Unfiltered — best left off unless needed" },
];

const initApps = [
  { name: "Google Chrome", signer: "Google LLC", team: "EQHXZ8M8AV", allowed: true, sys: false },
  { name: "ContentGuard Daemon", signer: "Your developer ID", team: "YOUR_ID", allowed: true, sys: false },
  { name: "ContentGuard Agent", signer: "Your developer ID", team: "YOUR_ID", allowed: true, sys: false },
  { name: "Visual Studio Code", signer: "Microsoft Corporation", team: "UBF8T346G9", allowed: true, sys: false },
  { name: "Warp (terminal)", signer: "Warp Technologies", team: "QX5ZR2B45A", allowed: true, sys: false },
  { name: "Terminal", signer: "Apple Inc.", team: "Apple", allowed: true, sys: true },
  { name: "Finder", signer: "Apple Inc.", team: "Apple", allowed: true, sys: true },
  { name: "System Settings", signer: "Apple Inc.", team: "Apple", allowed: true, sys: true },
  { name: "Preview", signer: "Apple Inc.", team: "Apple", allowed: true, sys: true },
  { name: "Activity Monitor", signer: "Apple Inc.", team: "Apple", allowed: true, sys: true },
  { name: "Safari", signer: "Apple Inc.", team: "Apple", allowed: false, sys: false },
  { name: "Firefox", signer: "Mozilla Corporation", team: "43AQ936H96", allowed: false, sys: false },
  { name: "Brave Browser", signer: "Brave Software", team: "KL8N8XSYF4", allowed: false, sys: false },
  { name: "Discord", signer: "Discord Inc.", team: "53Q6R32WPB", allowed: false, sys: false },
  { name: "Telegram", signer: "Telegram FZ-LLC", team: "C67CF9S4VU", allowed: false, sys: false },
  { name: "Slack", signer: "Slack Technologies", team: "BQR82RBBHL", allowed: false, sys: false },
];

const initMacRules = [
  { id: "prompt", name: "Monthly capture prompt", on: true, why: "Suppressed via forceBypassScreenCaptureAlert — removes the recurring deny opportunity" },
  { id: "airdrop", name: "AirDrop", on: true, why: "Files and images could arrive completely unfiltered" },
  { id: "wipe", name: "Erase all content and settings", on: true, why: "Blocks the quick factory-reset path" },
  { id: "acct", name: "New user accounts", on: true, why: "Prevents creating a second admin account" },
  { id: "acctmod", name: "Account modifications", on: true, why: "Username, password, and account type are locked" },
  { id: "prof", name: "Manual profile installs", on: true, why: "User can't add profiles that override managed settings" },
  { id: "disk", name: "Startup disk changes", on: true, why: "Can't switch to a different boot volume" },
  { id: "usb", name: "USB external storage", on: true, why: "External drives and media can't mount" },
  { id: "cap", name: "Screen capture by other apps", on: true, why: "Only the ContentGuard blocker can capture the screen" },
  { id: "appleId", name: "Apple ID password reset", on: true, why: "Prevents the 'forgot password' backdoor around the vault" },
];

const initChrome = [
  { id: "ext", name: "ContentGuard extension", on: true, forced: true, why: "Force-installed, can't be removed or disabled" },
  { id: "dev", name: "Developer tools", on: true, why: "Prevents DOM inspection to bypass the extension" },
  { id: "incog", name: "Incognito mode", on: true, why: "No private-window escape" },
  { id: "guest", name: "Guest mode", on: true, why: "No guest-profile escape" },
  { id: "exts", name: "Other extension installs", on: true, why: "Nothing can interfere with or replace the blocker" },
  { id: "signin", name: "Profile switching", on: true, why: "Can't sign into a profile without the extension" },
  { id: "doh", name: "Built-in DNS over HTTPS", on: true, why: "Chrome can't resolve names outside Gateway" },
];

const boot = [
  { name: "Recovery lock", why: "Password before recoveryOS loads — gates both recovery and safe mode", ok: true },
  { name: "FileVault encryption", why: "Full disk encryption, admin account excluded from unlock", ok: true },
  { name: "Activation lock", why: "A wipe or DFU restore still requires the iCloud password", ok: true },
  { name: "External boot disabled", why: "Can't start from a USB drive or Thunderbolt device", ok: true },
  { name: "Startup security: full", why: "Only the signed, sealed macOS on the internal disk", ok: true },
];

const permissions = [
  { name: "Accessibility", status: "Silently granted, locked", why: "For the blocker's force-exit-fullscreen action", locked: true },
  { name: "Screen recording", status: "Granted by you, can't be re-prompted", why: "Monthly prompt suppressed via MDM — only manual revocation triggers the dead-man's switch", locked: false },
];

const droidRules = [
  { name: "Intercept and cancel", why: "AccessibilityService blocks content before it paints — pre-render, not post-render like the Mac" },
  { name: "Screen overlay blur", why: "Covers content that slips past the first gate" },
  { name: "Package allowlist", why: "Only approved apps can open — same principle as Santa lockdown" },
  { name: "Safe boot restriction", why: "DISALLOW_SAFE_BOOT via device owner policy" },
  { name: "Factory reset blocked", why: "Device owner prevents wipe without the admin credential" },
  { name: "Uninstall protection", why: "ContentGuard can't be removed without stripping device owner (factory reset)" },
];

const vault = [
  { name: "Mac admin password", holder: "Time-locked vault", delay: "24 hours", icon: Monitor },
  { name: "iCloud / activation lock", holder: "Time-locked vault", delay: "24 hours", icon: Fingerprint },
  { name: "Cloudflare account", holder: "Time-locked vault", delay: "24 hours", icon: Globe },
  { name: "Recovery lock password", holder: "Time-locked vault", delay: "24 hours", icon: KeyRound },
  { name: "Screen Time passcode", holder: "Time-locked vault", delay: "24 hours", icon: Clock },
  { name: "Fleet API token", holder: "Worker environment — never on a device", delay: "n/a", icon: Server },
  { name: "Sealed backup", holder: "Accountability partner", delay: "In person", icon: FileKey },
];

const feed = [
  { t: "8 min ago", s: "Santa denied execution of an unsigned binary in ~/Downloads", kind: "block", sys: "mac" },
  { t: "43 min ago", s: "AI blocker covered explicit content detected in Preview", kind: "block", sys: "mac" },
  { t: "2 hours ago", s: "Gateway blocked a request to a domain in the adult category", kind: "block", sys: "net" },
  { t: "5 hours ago", s: "ContentGuard intercepted and cancelled content on Android", kind: "block", sys: "android" },
  { t: "Yesterday", s: "Blocker sensitivity increased from 75% to 80%", kind: "tighten", sys: "mac" },
  { t: "Yesterday", s: "WARP reconnected after sleep/wake cycle", kind: "info", sys: "net" },
  { t: "2 days ago", s: "Fleet synced 7 profiles successfully", kind: "info", sys: "mac" },
  { t: "3 days ago", s: "Santa rule added: blocked Brave Browser (Team ID)", kind: "tighten", sys: "mac" },
];

/* ── Nav items ───────────────────────────────────── */
const NAV = [
  { id: "home", label: "Home", icon: Shield, group: null },
  { id: "warp", label: "Cloudflare WARP", icon: Wifi, group: "Network" },
  { id: "gateway", label: "Gateway policies", icon: Globe, group: "Network" },
  { id: "bypass", label: "Bypass prevention", icon: Ban, group: "Network" },
  { id: "unifi", label: "UniFi router", icon: Router, group: "Network" },
  { id: "fleet", label: "Fleet MDM", icon: Server, group: "Mac" },
  { id: "santa", label: "App control", icon: AppWindow, group: "Mac" },
  { id: "blocker", label: "AI blocker", icon: Eye, group: "Mac" },
  { id: "restrict", label: "Restrictions", icon: HardDrive, group: "Mac" },
  { id: "chrome", label: "Chrome policy", icon: Chrome, group: "Mac" },
  { id: "boot", label: "Boot security", icon: Cpu, group: "Mac" },
  { id: "perms", label: "Permissions", icon: Fingerprint, group: "Mac" },
  { id: "cg", label: "ContentGuard", icon: Smartphone, group: "Android" },
  { id: "droid_rules", label: "Enforcement rules", icon: ShieldCheck, group: "Android" },
  { id: "vault_creds", label: "Credentials", icon: KeyRound, group: "Vault" },
  { id: "vault_break", label: "Break-glass", icon: AlertCircle, group: "Vault" },
  { id: "audit", label: "Audit log", icon: Activity, group: "Vault" },
];

/* ── Primitives ──────────────────────────────────── */
const Pill = ({ tone = "mint", children, icon: Icon }) => {
  const m = { mint: { bg: T.mint, fg: T.mintInk }, amber: { bg: T.amber, fg: T.amberInk }, rose: { bg: T.rose, fg: T.roseInk }, plain: { bg: T.line, fg: T.ink2 }, blue: { bg: T.blue, fg: T.blueInk } }[tone];
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: m.bg, color: m.fg, borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{Icon && <Icon size={12} strokeWidth={2.5} />}{children}</span>;
};

const Card = ({ children, style, dark }) => (
  <div style={{ background: dark ? T.forest : T.surface, border: dark ? "none" : `1px solid ${T.line}`, borderRadius: 16, overflow: "hidden", ...style }}>{children}</div>
);

const Stat = ({ label, value, good }) => (
  <div style={{ background: T.page, borderRadius: 12, padding: "12px 14px" }}>
    <div style={{ fontSize: 11, color: T.ink3, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: M, letterSpacing: "-0.02em", color: good ? T.mintInk : T.ink }}>{value}</div>
  </div>
);

const Grid = ({ children, cols }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${cols || 140}px, 1fr))`, gap: 8, marginBottom: 10 }}>{children}</div>
);

const Note = ({ icon: Icon, children, tone = "mint" }) => {
  const m = tone === "mint" ? { bg: T.mint, fg: T.mintInk } : tone === "amber" ? { bg: T.amber, fg: T.amberInk } : { bg: T.rose, fg: T.roseInk };
  return (
    <div style={{ display: "flex", gap: 10, background: m.bg, borderRadius: 14, padding: "13px 15px", margin: "0 0 14px", alignItems: "flex-start" }}>
      <Icon size={16} color={m.fg} strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13.5, color: m.fg, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
};

const SectionTitle = ({ children }) => (
  <div style={{ fontSize: 12, fontWeight: 700, color: T.ink3, textTransform: "uppercase", letterSpacing: "0.06em", margin: "18px 0 8px", padding: "0 2px" }}>{children}</div>
);

const Row = ({ children, last, onClick, pad = "13px 0" }) => (
  <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: pad, borderBottom: last ? "none" : `1px solid ${T.line}`, cursor: onClick ? "pointer" : "default" }}>{children}</div>
);

const Ratchet = ({ name, why, on, onTighten, onLoosen, last, forced }) => (
  <Row last={last}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{name}</div>
      {why && <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.35 }}>{why}</div>}
    </div>
    {forced ? <Pill tone="blue" icon={Check}>Forced</Pill> : on ? (
      <button onClick={onLoosen} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, background: T.forest, color: "#fff", border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
        <Lock size={12} strokeWidth={2.6} /> On
      </button>
    ) : (
      <button onClick={onTighten} style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, background: T.bright, color: T.forest, border: "none", borderRadius: 999, padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
        <ArrowUp size={12} strokeWidth={3} /> Turn on
      </button>
    )}
  </Row>
);

const Toast = ({ message, onDone }) => {
  useEffect(() => { const t = setTimeout(onDone, 2200); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: T.forest, color: "#fff", padding: "12px 20px", borderRadius: 999, fontSize: 14, fontWeight: 600, fontFamily: F, zIndex: 60, display: "flex", alignItems: "center", gap: 8, boxShadow: "0 8px 30px rgba(0,0,0,0.18)" }}>
      <Check size={16} strokeWidth={2.8} color={T.bright} />{message}
    </div>
  );
};

/* ── Vault sheet ─────────────────────────────────── */
const VaultSheet = ({ action, onClose }) => (
  <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(14,15,12,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50 }}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: T.surface, width: "100%", maxWidth: 520, borderRadius: "24px 24px 0 0", padding: "10px 20px 32px", fontFamily: F, maxHeight: "85vh", overflowY: "auto" }}>
      <div style={{ width: 36, height: 4, borderRadius: 99, background: T.line2, margin: "0 auto 20px" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <span style={{ width: 44, height: 44, borderRadius: 14, background: T.amber, display: "grid", placeItems: "center", flexShrink: 0 }}>
          <KeyRound size={21} color={T.amberInk} strokeWidth={2.2} />
        </span>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em" }}>This loosens your setup</div>
          <div style={{ fontSize: 13.5, color: T.ink3, marginTop: 2 }}>Vault password, then a 24-hour wait</div>
        </div>
      </div>

      <div style={{ background: T.page, borderRadius: 14, padding: "15px 17px", fontSize: 14, color: T.ink2, lineHeight: 1.55, marginBottom: 18 }}>
        You're asking to <strong style={{ color: T.ink }}>{action}</strong>. Tightening happens the moment you tap. Loosening goes through your vault and a delay you can't shorten.
      </div>

      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: T.ink2, marginBottom: 7 }}>Vault password</label>
      <input type="password" placeholder="Retrieved from your time-locked vault" style={{ width: "100%", boxSizing: "border-box", padding: "14px 16px", borderRadius: 12, border: `1.5px solid ${T.line2}`, background: T.surface, fontSize: 15, color: T.ink, outline: "none", fontFamily: F, marginBottom: 18 }} />

      <div style={{ display: "flex", gap: 11, alignItems: "flex-start", background: T.amber, borderRadius: 14, padding: "14px 16px", marginBottom: 22 }}>
        <Clock size={18} color={T.amberInk} strokeWidth={2.3} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 13.5, color: T.amberInk, lineHeight: 1.45 }}>
          <strong>Takes effect in 24 hours.</strong> The countdown runs on Cloudflare, not this device — changing the local clock does nothing. You can cancel at any point before it applies.
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: "15px 18px", borderRadius: 999, cursor: "pointer", border: `1.5px solid ${T.line2}`, background: T.surface, fontSize: 15, fontWeight: 700, color: T.ink, fontFamily: F }}>Cancel</button>
        <button style={{ flex: 1.4, padding: "15px 18px", borderRadius: 999, cursor: "pointer", border: "none", background: T.bright, color: T.forest, fontSize: 15, fontWeight: 700, fontFamily: F }}>Start the wait</button>
      </div>
    </div>
  </div>
);

/* ── Drawer nav ──────────────────────────────────── */
const Drawer = ({ open, current, onNav, onClose }) => {
  if (!open) return null;
  let lastGroup = null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(14,15,12,0.35)" }} />
      <nav onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: 280, maxWidth: "80vw", background: T.surface, height: "100%", overflowY: "auto", boxShadow: "4px 0 24px rgba(0,0,0,0.10)", padding: "20px 0 40px" }}>
        <div style={{ padding: "0 20px 18px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${T.line}` }}>
          <span style={{ width: 32, height: 32, borderRadius: 10, background: T.bright, display: "grid", placeItems: "center" }}>
            <Shield size={17} color={T.forest} strokeWidth={2.6} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em" }}>ContentGuard</div>
            <div style={{ fontSize: 11.5, color: T.ink3 }}>Central control panel</div>
          </div>
        </div>

        {NAV.map((item) => {
          const showGroup = item.group && item.group !== lastGroup;
          lastGroup = item.group;
          const active = current === item.id;
          return (
            <div key={item.id}>
              {showGroup && (
                <div style={{ fontSize: 11, fontWeight: 700, color: T.ink3, textTransform: "uppercase", letterSpacing: "0.07em", padding: "18px 20px 6px" }}>{item.group}</div>
              )}
              {!item.group && item.id !== "home" && <div style={{ height: 8 }} />}
              <button onClick={() => { onNav(item.id); onClose(); }} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "10px 20px", cursor: "pointer", fontFamily: F, fontSize: 14, fontWeight: active ? 700 : 500, color: active ? T.forest : T.ink2,
                background: active ? T.mint : "transparent", border: "none", textAlign: "left", borderRadius: 0,
              }}>
                <item.icon size={17} strokeWidth={active ? 2.5 : 2} color={active ? T.forest : T.ink3} />
                {item.label}
              </button>
            </div>
          );
        })}
      </nav>
    </div>
  );
};

/* ── Pages ───────────────────────────────────────── */
function HomePage() {
  return (
    <>
      <Card dark style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.bright, letterSpacing: "0.05em", textTransform: "uppercase" }}>How changes work</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: "-0.03em", lineHeight: 1.25, margin: "10px 0 16px" }}>Tighten anything instantly.<br />Loosening takes a day.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: T.bright, color: T.forest, borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 700 }}><ArrowUp size={13} strokeWidth={3} /> Tighten — one tap</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.12)", color: "#fff", borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 700 }}><ArrowDown size={13} strokeWidth={3} /> Loosen — vault + 24h</span>
        </div>
      </Card>

      <Card style={{ padding: "18px 18px 8px", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>System health</div>
        {[
          { icon: Globe, name: "Network", line: "WARP locked · full tunnel · Gateway active", ok: true },
          { icon: Server, name: "Fleet MDM", line: "Online · supervised · 7 profiles synced", ok: true },
          { icon: Eye, name: "AI blocker", line: "Watching · 1.2 fps · daemon healthy", ok: true },
          { icon: AppWindow, name: "Santa lockdown", line: "10 allowed · everything else denied", ok: true },
          { icon: Smartphone, name: "Android", line: "ContentGuard active · device owner", ok: true },
        ].map((s, i, a) => (
          <Row key={s.name} last={i === a.length - 1}>
            <span style={{ width: 36, height: 36, borderRadius: 11, background: T.mint, display: "grid", placeItems: "center", flexShrink: 0 }}>
              <s.icon size={17} color={T.mintInk} strokeWidth={2.2} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{s.name}</div>
              <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2 }}>{s.line}</div>
            </div>
            <Pill tone="mint" icon={Check}>On</Pill>
          </Row>
        ))}
      </Card>

      <Card style={{ padding: "18px 18px 8px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <Clock size={16} color={T.ink3} strokeWidth={2.2} />
          <span style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>Pending changes</span>
          <Pill tone="plain">0</Pill>
        </div>
        <div style={{ padding: "20px 16px", textAlign: "center", background: T.page, borderRadius: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 3 }}>Queue is empty</div>
          <div style={{ fontSize: 13, color: T.ink3 }}>Loosening requests show up here with a countdown until they apply.</div>
        </div>
      </Card>

      <Card style={{ padding: "18px 18px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <Activity size={16} color={T.ink3} strokeWidth={2.2} />
          <span style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>Recent activity</span>
        </div>
        {feed.map((f, i) => (
          <Row key={i} last={i === feed.length - 1} pad="10px 0">
            <span style={{ width: 7, height: 7, borderRadius: 99, marginTop: 5, flexShrink: 0, background: f.kind === "block" ? T.roseInk : f.kind === "tighten" ? T.mintInk : T.line2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: T.ink2, lineHeight: 1.4 }}>{f.s}</div>
              <div style={{ fontSize: 11.5, color: T.ink3, marginTop: 2 }}>{f.t} · {f.sys}</div>
            </div>
          </Row>
        ))}
      </Card>
    </>
  );
}

function WarpPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Cloudflare WARP</div>
      <Grid cols={130}>
        <Stat label="Tunnel" value="Connected" good />
        <Stat label="Mode" value="Full tunnel" />
        <Stat label="Switch" value="Locked" good />
        <Stat label="Admin override" value="Off" good />
        <Stat label="Auto-connect" value="5s" />
        <Stat label="Uptime" value="4d 7h" />
      </Grid>
      <Note icon={Check}>The switch is locked, quitting the app doesn't drop the tunnel, and the admin override is off. Even with admin, unlocking WARP goes through the vault.</Note>
      <Note icon={Shield} tone="amber">Global WARP override is disabled and the Cloudflare account credentials are in the time-locked vault. This is the one org-level kill switch — it stays off.</Note>
    </Card>
  );
}

function ListPage({ title, items, setItems, ask }) {
  const flip = (id) => setItems(items.map((x) => (x.id === id ? { ...x, on: true } : x)));
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>{title}</div>
      {items.map((r, i) => (
        <Ratchet key={r.id} name={r.name} why={r.why} on={r.on} forced={r.forced} last={i === items.length - 1}
          onTighten={() => flip(r.id)} onLoosen={() => ask(`turn off ${r.name.toLowerCase()}`)} />
      ))}
    </Card>
  );
}

function SantaPage({ apps, setApps, ask, toast }) {
  const [search, setSearch] = useState("");
  const allowed = apps.filter((a) => a.allowed);
  const blocked = apps.filter((a) => !a.allowed);
  const filter = (list) => search ? list.filter((a) => a.name.toLowerCase().includes(search.toLowerCase())) : list;

  const block = (name) => {
    setApps(apps.map((a) => (a.name === name ? { ...a, allowed: false } : a)));
    toast(`Blocked ${name}`);
  };

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, flex: 1 }}>App control — Santa</div>
        <Pill tone="mint" icon={Lock}>Lockdown</Pill>
      </div>

      <Note icon={Lock}>Everything not on the allowed list is denied on launch — including apps you compile yourself. Santa enforces this at the system-extension level.</Note>

      <div style={{ position: "relative", marginBottom: 16 }}>
        <Search size={16} color={T.ink3} style={{ position: "absolute", left: 14, top: 13 }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search apps…" style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px 12px 40px", borderRadius: 12, border: `1.5px solid ${T.line2}`, background: T.page, fontSize: 14, color: T.ink, outline: "none", fontFamily: F }} />
      </div>

      <SectionTitle>Allowed · {allowed.length}</SectionTitle>
      {filter(allowed).map((a, i, arr) => (
        <Row key={a.name} last={i === arr.length - 1}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{a.name}</div>
            <div style={{ fontSize: 12, color: T.ink3, marginTop: 1 }}>{a.signer}</div>
          </div>
          {a.sys ? <Pill tone="plain">System</Pill> : (
            <button onClick={() => block(a.name)} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: T.bright, color: T.forest, border: "none", borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
              <ArrowUp size={12} strokeWidth={3} /> Block
            </button>
          )}
        </Row>
      ))}

      <SectionTitle>Blocked · {blocked.length}</SectionTitle>
      {filter(blocked).map((a, i, arr) => (
        <Row key={a.name} last={i === arr.length - 1}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{a.name}</div>
            <div style={{ fontSize: 12, color: T.ink3, marginTop: 1 }}>{a.signer}</div>
          </div>
          <button onClick={() => ask(`allow ${a.name} to run`)} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: T.forest, color: "#fff", border: "none", borderRadius: 999, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: F }}>
            <Lock size={12} strokeWidth={2.6} /> Allow
          </button>
        </Row>
      ))}
    </Card>
  );
}

function BlockerPage({ ask }) {
  const [sens, setSens] = useState(80);
  const [bo, setBo] = useState(10);
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>AI blocker</div>
      <Grid cols={130}>
        <Stat label="State" value="Watching" good />
        <Stat label="Capture rate" value="1.2 fps" />
        <Stat label="Last cover" value="43 min" />
        <Stat label="Blackouts today" value="1" />
        <Stat label="Daemon" value="Healthy" good />
        <Stat label="Heartbeat" value="OK" good />
      </Grid>

      <Note icon={Eye}>Watches every app on screen — browser included. Content that triggers the classifier is covered immediately, then the daemon enforces a timed blackout that survives quitting the app.</Note>

      <SectionTitle>Sensitivity</SectionTitle>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 0 2px" }}>
        <span style={{ fontSize: 13, color: T.ink3 }}>Drag right freely — left needs the vault</span>
        <span style={{ fontSize: 17, fontWeight: 700, fontFamily: M, color: T.ink }}>{sens}%</span>
      </div>
      <input type="range" min={50} max={100} value={sens}
        onChange={(e) => { const v = +e.target.value; v >= sens ? setSens(v) : ask("lower blocker sensitivity"); }}
        style={{ width: "100%", accentColor: T.forest, margin: "6px 0 8px" }} />

      <SectionTitle>Blackout duration</SectionTitle>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "4px 0 2px" }}>
        <span style={{ fontSize: 13, color: T.ink3 }}>Held by the daemon, not the app</span>
        <span style={{ fontSize: 17, fontWeight: 700, fontFamily: M, color: T.ink }}>{bo} min</span>
      </div>
      <input type="range" min={1} max={30} value={bo}
        onChange={(e) => { const v = +e.target.value; v >= bo ? setBo(v) : ask("shorten the blackout timer"); }}
        style={{ width: "100%", accentColor: T.forest, margin: "6px 0 8px" }} />

      <SectionTitle>Dead-man's switch</SectionTitle>
      <Note icon={AlertCircle} tone="amber">If the blocker goes down — killed, crashed, or Screen Recording revoked — the daemon detects the missing heartbeat and locks the screen until capture resumes. Killing the blocker doesn't show you content; it locks you out.</Note>
    </Card>
  );
}

function FleetPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Fleet MDM</div>
      <Grid cols={130}>
        <Stat label="Connection" value="Online" good />
        <Stat label="Supervised" value="Yes" good />
        <Stat label="Last check-in" value="30s ago" />
        <Stat label="Profiles active" value="7" />
        <Stat label="Enrolled" value="UAMDM" />
        <Stat label="APNs cert" value="Valid" good />
      </Grid>
      <Note icon={Server}>Fleet runs on Fly.io behind a Cloudflare Tunnel. The Mac checks in periodically and pulls profile updates. If Fleet goes down, existing restrictions stay enforced — you just can't push changes until it's back.</Note>
      <SectionTitle>Active profiles</SectionTitle>
      {["PPPC — Accessibility + Screen Recording", "Restrictions — macOS", "Chrome managed policy", "DNS settings (Gateway DoH)", "WARP client configuration", "System extension approval", "Santa configuration"].map((p, i, a) => (
        <Row key={p} last={i === a.length - 1} pad="10px 0">
          <Check size={14} color={T.mintInk} strokeWidth={2.5} style={{ flexShrink: 0 }} />
          <div style={{ fontSize: 13.5, color: T.ink2 }}>{p}</div>
        </Row>
      ))}
    </Card>
  );
}

function BootPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Boot and recovery security</div>
      <Note icon={Lock}>Every path to bypassing the running OS is gated. Recovery and safe mode need the recovery lock password (vaulted). A wipe hits activation lock (iCloud password, also vaulted). External boot is disabled.</Note>
      {boot.map((b, i) => (
        <Row key={b.name} last={i === boot.length - 1}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{b.name}</div>
            <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.35 }}>{b.why}</div>
          </div>
          <Pill tone="mint" icon={Check}>On</Pill>
        </Row>
      ))}
    </Card>
  );
}

function PermsPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Permissions (PPPC)</div>
      {permissions.map((p, i) => (
        <Row key={p.name} last={i === permissions.length - 1}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{p.name}</div>
            <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.35 }}>{p.why}</div>
          </div>
          <Pill tone={p.locked ? "mint" : "amber"} icon={p.locked ? Lock : AlertCircle}>{p.status}</Pill>
        </Row>
      ))}
      <Note icon={AlertCircle} tone="amber" style={{ marginTop: 14 }}>Screen recording can't be locked on by any MDM — it's the one Apple-imposed soft spot. Revoking it triggers the dead-man's switch instead.</Note>
    </Card>
  );
}

function CGPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>ContentGuard — Android</div>
      <Grid cols={130}>
        <Stat label="State" value="Active" good />
        <Stat label="Device owner" value="Yes" good />
        <Stat label="Accessibility" value="Running" good />
        <Stat label="Last block" value="5h ago" />
        <Stat label="Overlay" value="Ready" good />
        <Stat label="Model" value="SigLIP2" />
      </Grid>
      <Note icon={Zap}>Android catches content before it paints — the AccessibilityService intercepts and cancels, which the Mac can't do. This is the strongest detection surface in the whole stack.</Note>
    </Card>
  );
}

function DroidRulesPage({ ask }) {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Enforcement rules</div>
      {droidRules.map((d, i) => (
        <Row key={d.name} last={i === droidRules.length - 1}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{d.name}</div>
            <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.35 }}>{d.why}</div>
          </div>
          <Pill tone="mint" icon={Check}>On</Pill>
        </Row>
      ))}
    </Card>
  );
}

function VaultCredsPage() {
  return (
    <>
      <Card dark style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.bright, letterSpacing: "0.05em", textTransform: "uppercase" }}>The load-bearing layer</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", letterSpacing: "-0.025em", lineHeight: 1.3, margin: "8px 0 10px" }}>Every layer can be undone with these credentials. Nothing else can.</div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.7)", lineHeight: 1.5 }}>If the vault is easy to open, none of the rest counts for much. The time-lock is the point.</div>
      </Card>
      <Card style={{ padding: 18 }}>
        {vault.map((v, i) => (
          <Row key={v.name} last={i === vault.length - 1}>
            <span style={{ width: 34, height: 34, borderRadius: 10, background: T.page, display: "grid", placeItems: "center", flexShrink: 0 }}>
              <v.icon size={16} color={T.ink3} strokeWidth={2.2} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{v.name}</div>
              <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 1 }}>{v.holder}</div>
            </div>
            <Pill tone={v.delay === "n/a" || v.delay === "In person" ? "plain" : "amber"} icon={v.delay === "n/a" || v.delay === "In person" ? undefined : Clock}>{v.delay}</Pill>
          </Row>
        ))}
      </Card>
    </>
  );
}

function BreakGlassPage() {
  const steps = [
    { n: "Re-approve screen recording", d: "If the blocker loses permission, you just click Allow again — no admin, no vault needed. This is the normal monthly path." },
    { n: "Admin release from the vault", d: "For a stuck blackout or a fail-closed bug. Retrieve the admin password from the vault (24-hour wait), then run the release command. The wait is the friction that keeps this from becoming the bypass." },
    { n: "Sealed envelope", d: "Your accountability partner holds a physical copy of the admin password. For the scenario where the vault itself is inaccessible — app failure, lost master password, service outage." },
  ];
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Break-glass recovery</div>
      <Note icon={AlertCircle} tone="amber">A bug should never be able to permanently lock you out of your own machine. These three paths get you back in, cheapest first.</Note>
      {steps.map((s, i) => (
        <Row key={s.n} last={i === steps.length - 1}>
          <span style={{ width: 24, height: 24, borderRadius: 99, background: T.page, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, color: T.ink2, fontFamily: M, flexShrink: 0 }}>{i + 1}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{s.n}</div>
            <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2, lineHeight: 1.45 }}>{s.d}</div>
          </div>
        </Row>
      ))}
    </Card>
  );
}

function AuditPage() {
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Audit log</div>
      <div style={{ fontSize: 13, color: T.ink3, marginBottom: 14, lineHeight: 1.45 }}>Every change, detection, and system event — newest first. Every loosening request is logged even if cancelled.</div>
      {feed.map((f, i) => (
        <Row key={i} last={i === feed.length - 1} pad="10px 0">
          <span style={{ width: 8, height: 8, borderRadius: 99, marginTop: 5, flexShrink: 0, background: f.kind === "block" ? T.roseInk : f.kind === "tighten" ? T.mintInk : T.line2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: T.ink, lineHeight: 1.4, fontWeight: 500 }}>{f.s}</div>
            <div style={{ fontSize: 12, color: T.ink3, marginTop: 2 }}>{f.t} · {f.sys}</div>
          </div>
          <Pill tone={f.kind === "block" ? "rose" : f.kind === "tighten" ? "mint" : "plain"}>
            {f.kind === "block" ? "Blocked" : f.kind === "tighten" ? "Tightened" : "Info"}
          </Pill>
        </Row>
      ))}
    </Card>
  );
}

/* ── Shell ────────────────────────────────────────── */
export default function App() {
  const [page, setPage] = useState("home");
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const ask = (a) => setSheet(a);
  const toast = useCallback((m) => setToastMsg(m), []);

  // State
  const [gw, setGw] = useState(initGateway);
  const [bypass, setBypass] = useState(initBypass);
  const [unifi, setUnifi] = useState(initUnifi);
  const [apps, setApps] = useState(initApps);
  const [macR, setMacR] = useState(initMacRules);
  const [chromeR, setChromeR] = useState(initChrome);

  const current = NAV.find((n) => n.id === page);
  const pageTitle = current ? current.label : "Home";

  return (
    <div style={{ background: T.page, minHeight: "100vh", fontFamily: F, color: T.ink }}>
      {/* Header */}
      <header style={{ background: T.surface, borderBottom: `1px solid ${T.line}`, padding: "0 16px", position: "sticky", top: 0, zIndex: 30, height: 56, display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => setDrawer(true)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "grid", placeItems: "center" }}>
          <Menu size={22} color={T.ink} strokeWidth={2.2} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.ink, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pageTitle}</div>
        </div>
        <Pill tone="mint" icon={Check}>All on</Pill>
      </header>

      {/* Drawer */}
      <Drawer open={drawer} current={page} onNav={setPage} onClose={() => setDrawer(false)} />

      {/* Content */}
      <main style={{ maxWidth: 620, margin: "0 auto", padding: "14px 12px 50px" }}>
        {page === "home" && <HomePage />}
        {page === "warp" && <WarpPage />}
        {page === "gateway" && <ListPage title="Gateway DNS policies" items={gw} setItems={setGw} ask={ask} />}
        {page === "bypass" && <ListPage title="Bypass prevention" items={bypass} setItems={setBypass} ask={ask} />}
        {page === "unifi" && <ListPage title="UniFi router" items={unifi} setItems={setUnifi} ask={ask} />}
        {page === "fleet" && <FleetPage />}
        {page === "santa" && <SantaPage apps={apps} setApps={setApps} ask={ask} toast={toast} />}
        {page === "blocker" && <BlockerPage ask={ask} />}
        {page === "restrict" && <ListPage title="macOS restrictions" items={macR} setItems={setMacR} ask={ask} />}
        {page === "chrome" && <ListPage title="Chrome policy" items={chromeR} setItems={setChromeR} ask={ask} />}
        {page === "boot" && <BootPage />}
        {page === "perms" && <PermsPage />}
        {page === "cg" && <CGPage />}
        {page === "droid_rules" && <DroidRulesPage ask={ask} />}
        {page === "vault_creds" && <VaultCredsPage />}
        {page === "vault_break" && <BreakGlassPage />}
        {page === "audit" && <AuditPage />}
      </main>

      {sheet && <VaultSheet action={sheet} onClose={() => setSheet(null)} />}
      {toastMsg && <Toast message={toastMsg} onDone={() => setToastMsg(null)} />}
    </div>
  );
}
