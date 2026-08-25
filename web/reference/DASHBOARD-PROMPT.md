# ContentGuard Central — Web Dashboard Implementation

## Overview

Build the ContentGuard Central web dashboard — a unified control panel for managing NSFW content blocking across Network (Cloudflare/UniFi), Mac (Fleet MDM/Santa/AI blocker), and Android (ContentGuard app). 

The dashboard is hosted on **Cloudflare Pages** and talks to a **Cloudflare Worker** which holds all API credentials and enforces the ratchet (strengthen = immediate, weaken = vault password + 24-hour timer).

A **UI prototype** is attached as `ContentGuardCentral.jsx`. This is the **design reference** — match its visual design, layout, interactions, and page structure. The prototype uses mock data and local state; the real implementation connects to the Worker API for live data.

---

## Architecture

```
[Web dashboard — Cloudflare Pages]
    ↓ authenticated API calls
[Cloudflare Worker — the brain]
    ├── Durable Object (settings state + timelock timers)
    ├── Fleet API client → Fleet MDM (manages the Mac)
    ├── Cloudflare API client → Gateway, WARP, DNS
    ├── UniFi API client → router settings
    ├── Santa sync protocol → serves rules to Santa on the Mac
    └── Profile generator → builds .mobileconfig from toggle state
```

The dashboard is a **thin frontend** — it holds no credentials, no API tokens, no powerful secrets. Everything goes through the Worker, which enforces the ratchet.

---

## Design system — Wise light

Match the prototype's visual language exactly. These are the design tokens:

```typescript
export const tokens = {
  bright: "#9FE870",      // Primary action — tighten buttons
  forest: "#163300",      // Primary dark — loosen buttons, active nav, hero backgrounds
  ink: "#0E0F0C",         // Primary text
  ink2: "#454745",        // Secondary text
  ink3: "#6A6C6A",        // Tertiary text
  page: "#F2F3F0",        // Page background
  surface: "#FFFFFF",     // Card background
  line: "#EAECE6",        // Hairline borders
  line2: "#DFE1DB",       // Heavier borders (inputs, sheet handle)
  mint: "#E8F5D0",        // Positive tint (on, healthy, pass)
  mintInk: "#2F5711",     // Positive text
  amber: "#FFF4CC",       // Caution tint (pending, time-locked)
  amberInk: "#7A5B00",    // Caution text
  rose: "#FFE9E5",        // Negative tint (blocked, failed)
  roseInk: "#A8200D",     // Negative text
  blue: "#E3EEFF",        // Info tint (forced, managed)
  blueInk: "#1A4B99",     // Info text
};

export const font = {
  body: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Roboto Mono', monospace",
};
```

### Key visual patterns from the prototype

- **Cards**: white surface, 1px `line` border, 16px border-radius, no shadow
- **Stats**: `page` background, 12px border-radius, monospace values, uppercase label
- **Pill badges**: 999px border-radius, 4px 10px padding, 12px font, 600 weight — tones: mint (on), amber (pending), rose (blocked), plain (neutral), blue (forced/managed)
- **Hero cards**: `forest` background, `bright` eyebrow text, white title — used on Home and Vault pages
- **Notes/callouts**: tinted background (mint/amber/rose) with matching icon + text, 14px border-radius
- **Section titles**: 12px uppercase, 700 weight, `ink3` color, 0.06em letter-spacing
- **Rows**: flex layout, 13px padding vertical, `line` border-bottom (last row none)
- **Typography**: titles 15-17px 700 weight, body 13-14px 500-600 weight, descriptions 12.5px `ink3`

### The signature interaction — the ratchet

Every setting control uses the same button asymmetry:

**Tighten** (making things stricter):
- Bright green pill (`bright` bg, `forest` text)
- Up arrow icon (ArrowUp)
- One tap, immediate, no auth
- Label examples: "Turn on", "Block"

**Loosen** (making things more permissive):
- Dark pill (`forest` bg, white text)
- Lock icon
- Tap opens the vault bottom sheet
- Label examples: "On" (with lock — meaning it's on and loosening needs the vault), "Allow"

**Sliders** (sensitivity, blackout timer):
- Drag right = tighten = free
- Drag left = loosen = triggers vault sheet
- Implement by comparing new value to current: `newVal >= current` → allow, else → trigger vault sheet

### The vault bottom sheet

Triggered on any weaken action. Slides up from the bottom, 24px border-radius top corners, backdrop blur:

1. Handle bar (36x4px, `line2`, centered)
2. Header: amber icon circle + "This loosens your setup" title + "Vault password, then a 24-hour wait" subtitle
3. Explanation box (`page` bg, 14px radius): describes the specific action
4. Password input: full-width, 12px radius, `line2` border
5. Timer warning: amber callout with Clock icon — "Applies in 24 hours. The countdown runs on Cloudflare, not this device."
6. Two buttons: Cancel (outlined) and "Start the wait" (bright green) — both pill-shaped (999px radius)

---

## Navigation — hamburger drawer

Slide-out drawer from the left, grouped by platform:

```
ContentGuard (logo + title)
─────────────────────────
Home                        ← no group header

Network                     ← group header
  Cloudflare WARP
  Gateway policies
  Bypass prevention
  UniFi router

Mac                         ← group header
  Fleet MDM
  App control
  AI blocker
  Restrictions
  Chrome policy
  Boot security
  Permissions

Android                     ← group header
  ContentGuard
  Enforcement rules

Vault                       ← group header
  Credentials
  Break-glass
  Audit log
```

Active page: `mint` background, `forest` text, heavier icon stroke. Inactive: transparent, `ink2` text.

Header bar: sticky, white background, `line` bottom border, 56px height. Hamburger icon left, page title center-left, "All on" pill right.

---

## Pages (17 total)

Match the prototype's content and layout for each page. The key difference from the prototype: **replace local state with Worker API calls.**

### Data flow pattern

Every page follows this pattern:

```typescript
// Load state from the Worker
const { data, isLoading } = useQuery('/api/state');

// Strengthen action (immediate)
async function handleStrengthen(setting: string, value: any) {
  await fetch('/api/strengthen', {
    method: 'POST',
    body: JSON.stringify({ setting, value }),
  });
  // Optimistic update or refetch
}

// Weaken action (opens vault sheet)
function handleWeaken(setting: string, value: any, description: string) {
  openVaultSheet({
    action: description,
    onSubmit: async (vaultPassword: string) => {
      await fetch('/api/weaken', {
        method: 'POST',
        body: JSON.stringify({ setting, value, password: vaultPassword }),
      });
      // Refetch — change won't apply for 24h but will show as pending
    },
  });
}
```

### Page list with data sources

| Page | Data source | Writes to |
|---|---|---|
| **Home** | `GET /api/status` (all systems health) + `GET /api/pending` + `GET /api/audit` | — |
| **WARP** | `GET /api/state` (warp section) | Read-only status |
| **Gateway policies** | `GET /api/state` (gateway categories) | `POST /api/strengthen` or `/api/weaken` |
| **Bypass prevention** | `GET /api/state` (bypass rules) | `POST /api/strengthen` or `/api/weaken` |
| **UniFi** | `GET /api/state` (unifi section) | `POST /api/strengthen` or `/api/weaken` |
| **Fleet MDM** | `GET /api/status` (fleet section) | Read-only status |
| **App control (Santa)** | `GET /api/apps` (from Fleet osquery) + `GET /api/state` (santa rules) | `POST /api/strengthen` (block) or `/api/weaken` (allow) |
| **AI blocker** | `GET /api/status` (blocker section) | `POST /api/strengthen` (increase sensitivity/blackout) or `/api/weaken` (decrease) |
| **Restrictions** | `GET /api/state` (mac restrictions) | `POST /api/strengthen` or `/api/weaken` |
| **Chrome policy** | `GET /api/state` (chrome section) | `POST /api/strengthen` or `/api/weaken` |
| **Boot security** | `GET /api/status` (boot section) | Read-only status |
| **Permissions** | `GET /api/status` (pppc section) | Read-only status |
| **ContentGuard (Android)** | `GET /api/status` (android section) | Read-only status |
| **Enforcement rules (Android)** | `GET /api/status` (android rules) | Read-only status |
| **Vault credentials** | Static content (no API call — credential list is display-only) | — |
| **Break-glass** | Static content | — |
| **Audit log** | `GET /api/audit` | Read-only |

---

## Worker API contract

### Endpoints

```
GET  /api/state          → full current state of all toggles/settings
GET  /api/status         → health/connection status of all systems
GET  /api/apps           → installed apps from Fleet (proxied osquery)
GET  /api/pending        → pending weaken requests with countdown timers
GET  /api/audit          → event log (newest first)

POST /api/strengthen     → apply a tightening change (immediate)
     Body: { setting: string, value: any }

POST /api/weaken         → request a loosening change (starts 24h timer)
     Body: { setting: string, value: any, password: string }

POST /api/cancel/:id     → cancel a pending weaken request
```

### State shape

```typescript
interface ContentGuardState {
  gateway: {
    categories: Array<{ id: string; name: string; blocked: boolean }>;
  };
  bypass: {
    rules: Array<{ id: string; name: string; blocked: boolean; why: string }>;
  };
  unifi: {
    rules: Array<{ id: string; name: string; enabled: boolean; why: string }>;
  };
  santa: {
    mode: 'LOCKDOWN' | 'MONITOR';
    rules: Array<{
      identifier: string;
      name: string;
      signer: string;
      type: 'TEAMID' | 'SIGNINGID' | 'BINARY';
      policy: 'ALLOWLIST' | 'BLOCKLIST';
      system: boolean;
    }>;
  };
  blocker: {
    sensitivity: number;       // 50-100
    blackoutMinutes: number;   // 1-30
  };
  macRestrictions: {
    rules: Array<{ id: string; name: string; enabled: boolean; why: string }>;
  };
  chromePolicy: {
    rules: Array<{ id: string; name: string; enabled: boolean; forced?: boolean; why?: string }>;
  };
}

interface SystemStatus {
  network: { state: 'on' | 'off' | 'error'; detail: string };
  fleet: { state: 'on' | 'off' | 'error'; detail: string; supervised: boolean; profiles: number; lastCheckin: string };
  blocker: { state: 'on' | 'off' | 'error'; fps: number; lastDetection: string; blackoutsToday: number; daemonHealthy: boolean; heartbeat: boolean };
  santa: { state: 'on' | 'off' | 'error'; mode: string; allowedCount: number; blockedCount: number };
  android: { state: 'on' | 'off' | 'error'; detail: string };
  warp: { connected: boolean; mode: string; switchLocked: boolean; adminOverride: boolean; autoConnect: string; uptime: string };
  boot: { recoveryLock: boolean; fileVault: boolean; activationLock: boolean; externalBoot: boolean };
  permissions: { accessibility: { granted: boolean; locked: boolean }; screenRecording: { granted: boolean } };
}

interface PendingChange {
  id: string;
  action: string;
  requestedAt: string;
  appliesAt: string;       // 24h after requestedAt
  setting: string;
  value: any;
}

interface AuditEntry {
  timestamp: string;
  action: string;
  kind: 'block' | 'tighten' | 'loosen' | 'info';
  system: 'network' | 'mac' | 'android';
}
```

---

## Tech stack

- **Framework:** React + TypeScript
- **Build:** Vite
- **Hosting:** Cloudflare Pages
- **Styling:** CSS-in-JS (inline styles matching the prototype — use the token objects, no Tailwind, no CSS files)
- **Icons:** lucide-react
- **Data fetching:** `fetch` with `useEffect` + `useState` (or a lightweight hook like `useSWR` if you prefer — keep dependencies minimal)
- **Auth:** Cloudflare Access JWT validation (the Worker validates the JWT; the dashboard just passes it)
- **Routing:** simple state-based page switching (no React Router needed — the prototype uses `useState` for the current page, keep that pattern)

---

## Project structure

```
web/
├── src/
│   ├── App.tsx                      ← Shell: header, drawer, page routing, vault sheet
│   ├── pages/
│   │   ├── Home.tsx
│   │   ├── Warp.tsx
│   │   ├── Gateway.tsx
│   │   ├── Bypass.tsx
│   │   ├── Unifi.tsx
│   │   ├── Fleet.tsx
│   │   ├── Santa.tsx
│   │   ├── Blocker.tsx
│   │   ├── Restrictions.tsx
│   │   ├── ChromePolicy.tsx
│   │   ├── BootSecurity.tsx
│   │   ├── Permissions.tsx
│   │   ├── ContentGuardAndroid.tsx
│   │   ├── DroidRules.tsx
│   │   ├── VaultCredentials.tsx
│   │   ├── BreakGlass.tsx
│   │   └── AuditLog.tsx
│   │
│   ├── components/
│   │   ├── Drawer.tsx               ← Hamburger slide-out nav
│   │   ├── RatchetRow.tsx           ← Tighten/loosen toggle row
│   │   ├── VaultSheet.tsx           ← Bottom sheet for weaken requests
│   │   ├── Card.tsx                 ← White surface card with border
│   │   ├── Stat.tsx                 ← Metric card (label + monospace value)
│   │   ├── Grid.tsx                 ← Auto-fit grid for stat cards
│   │   ├── Pill.tsx                 ← Status badge (mint/amber/rose/plain/blue)
│   │   ├── Note.tsx                 ← Callout box (mint/amber/rose)
│   │   ├── Row.tsx                  ← Flex row with bottom border
│   │   ├── SectionTitle.tsx         ← Uppercase section header
│   │   ├── Toast.tsx                ← Confirmation toast
│   │   └── AppRow.tsx               ← App list row (for Santa page)
│   │
│   ├── lib/
│   │   ├── api.ts                   ← Worker API client (all fetch calls)
│   │   ├── tokens.ts                ← Wise light design tokens
│   │   └── types.ts                 ← TypeScript interfaces
│   │
│   ├── index.tsx                    ← Entry point
│   └── index.html
│
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Implementation notes

### Start from the prototype

The attached `ContentGuardCentral.jsx` is a single-file React component with everything inline. To implement the real dashboard:

1. **Extract** the reusable components (Pill, Card, Panel/now renamed to collapsible sections, RatchetRow, VaultSheet, Stat, Grid, Note, Toast, Drawer) into `components/`.
2. **Extract** the page content (Overview, Network, Mac, Android, Vault sections) into `pages/`.
3. **Extract** the design tokens into `lib/tokens.ts`.
4. **Replace** local `useState` mock data with API calls to the Worker.
5. **Keep** the inline styling approach — the prototype's style objects translate directly. Don't switch to Tailwind or CSS modules.

### What changes from prototype to production

| Prototype | Production |
|---|---|
| Mock data in `useState` | Fetched from Worker API |
| Local state toggles | API calls (`/api/strengthen` or `/api/weaken`) |
| Instant vault sheet dismiss | Vault sheet submits password to Worker, shows loading, handles errors |
| No error states | Loading spinners, error messages, retry |
| No pending changes with real timers | Pending queue shows live countdowns from Worker data |
| Static audit log | Real events from Worker |
| No authentication | Cloudflare Access JWT passed with every request |

### What stays the same

| Aspect | Keep as-is from prototype |
|---|---|
| Visual design | Exact same tokens, spacing, typography, border-radius |
| Inline styles | Same approach — style objects, not CSS classes |
| Navigation | Hamburger drawer with grouped sections |
| Ratchet interaction | Green pill = tighten = instant; dark pill + lock = loosen = vault sheet |
| Slider behaviour | Right = free, left = vault |
| Page structure | Same sections, same stat grids, same row layouts |
| Hero cards | Same dark cards on Home and Vault pages |
| Button shapes | Pill-shaped (999px radius) everywhere |

### Mobile responsiveness

The prototype is already mobile-first. Maintain:
- Max-width 620px centered content
- Single-column layout
- Full-width cards
- Touch-friendly tap targets (minimum 44px)
- Bottom sheet (not modal dialog) for the vault
- Drawer slides from left, overlay behind

---

## Deployment

```bash
cd web
npm install
npm run build        # Vite builds to dist/
wrangler pages deploy dist --project-name contentguard-central
```

Set up Cloudflare Access to gate the dashboard URL — only your authenticated session can reach it.

---

## Reference

The attached `ContentGuardCentral.jsx` is the complete visual reference. Every component, every layout decision, every interaction is in there. Build the production app to look and feel identical — just wired to real data instead of mock state.
