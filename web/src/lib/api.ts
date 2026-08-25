// Worker API client - every function here calls a route that already
// exists and already works in worker/src/index.ts, same as
// worker/src/dashboard.ts's own `api()` helper. No new endpoints, no
// Durable Object, no Cloudflare Access JWT - this dashboard is served
// from a different origin (Cloudflare Pages) than the Worker
// (panel.lukep009.download), so cross-origin cookie auth needs the
// Worker's CORS response to actually allow it; see web/README.md for
// what that requires server-side if/when this gets deployed for real.
// `credentials: "include"` matches the existing dashboard's own pattern -
// this Worker's session is a signed cookie, not a bearer token.

import type {
  ConfigProfileDetail,
  HostStatus,
  InstalledApp,
  KnownApp,
  LoosenRequest,
  PendingPasswordChange,
  PendingProfileChange,
  Rule,
  RuleType,
  SafeApp,
  SafeAppAddition,
  StaticRule,
  StaticSafeApp,
} from "./types";

export class ApiError extends Error {}

// The existing dashboard.ts recovers from a 401 with `location.reload()`
// - that works there because index.ts's GET / is server-rendered and
// picks login-page-vs-dashboard based on session validity on every
// request. This app is a static SPA (no server-side page choice to
// reload into), so a 401 instead calls this - App.tsx registers it once
// to flip back to the login screen, same effect via client-side state.
let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...opts, credentials: "include" });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError("session expired - please log in again");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(`${res.status}: ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? ((await res.json()) as T) : (null as T);
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// --- Auth ---
export const login = (password: string) => request<void>("/api/login", json({ password }));
export const logout = () => request<void>("/api/logout", { method: "POST" });
export const changeLoginPassword = (current_password: string, new_password: string) =>
  request<void>("/api/login-password/change", json({ current_password, new_password }));
export const requestOfficePasswordChange = (current_password: string, new_password: string) =>
  request<{ id: number; applies_at: number }>("/api/password/change-request", json({ current_password, new_password }));
export const getPendingOfficePasswordChange = () =>
  request<PendingPasswordChange | null>("/api/password/pending-change");
export const cancelOfficePasswordChange = (id: number) =>
  request<void>(`/api/password/change-request/${id}/cancel`, { method: "POST" });

// --- Santa rules ---
export const getStaticRules = () => request<StaticRule[]>("/api/static-rules");
export const getRules = () => request<Rule[]>("/api/rules");
export const getLoosenRequests = () => request<LoosenRequest[]>("/api/loosen-requests");
export const createRule = (identifier: string, rule_type: RuleType, policy: "ALLOWLIST" | "BLOCKLIST", notification_app_name?: string) =>
  request<Rule>("/api/rules", json({ identifier, rule_type, policy, notification_app_name }));
export const requestLoosenRule = (ruleId: number, password: string) =>
  request<{ id: number; applies_at: number }>(`/api/rules/${ruleId}/loosen-request`, json({ password }));
export const cancelLoosenRequest = (id: number) =>
  request<void>(`/api/loosen-requests/${id}/cancel`, { method: "POST" });

// --- Safe apps ---
export const getStaticSafeApps = () => request<StaticSafeApp[]>("/api/static-safe-apps");
export const getSafeApps = () => request<SafeApp[]>("/api/safe-apps");
export const getSafeAppAdditions = () => request<SafeAppAddition[]>("/api/safe-app-additions");
export const requestAddSafeApp = (bundle_id: string, name: string | undefined, password: string) =>
  request<SafeAppAddition>("/api/safe-apps", json({ bundle_id, name, password }));
export const removeSafeApp = (bundleId: string) =>
  request<void>(`/api/safe-apps/${encodeURIComponent(bundleId)}`, { method: "DELETE" });
export const cancelSafeAppAddition = (id: number) =>
  request<void>(`/api/safe-app-additions/${id}/cancel`, { method: "POST" });

// --- Installed apps ---
export const getInstalledSoftware = (host?: string) =>
  request<InstalledApp[]>(`/api/installed-software${host ? `?host=${encodeURIComponent(host)}` : ""}`);
export const getKnownApps = () => request<KnownApp[]>("/api/known-apps");

// --- Host status / MDM ---
export const getHostStatus = () => request<HostStatus>("/api/host-status");
export const getConfigProfileDetails = () => request<ConfigProfileDetail[]>("/api/config-profile-details");
export const getPendingProfileChanges = () => request<PendingProfileChange[]>("/api/pending-profile-changes");
export const cancelProfileChange = (id: number) =>
  request<void>(`/api/pending-profile-changes/${id}/cancel`, { method: "POST" });
export const updateConfigProfile = (profileUuid: string, formData: FormData) =>
  request<void>(`/api/config-profiles/${encodeURIComponent(profileUuid)}`, { method: "PATCH", body: formData });
