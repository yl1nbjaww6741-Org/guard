import { useMemo, useState } from "react";
import { Search, Lock, ArrowUp, Check } from "lucide-react";
import { tokens as T, font as F } from "../lib/tokens";
import { Card } from "../components/Card";
import { Row } from "../components/Row";
import { Pill } from "../components/Pill";
import { Note } from "../components/Note";
import { SectionTitle } from "../components/SectionTitle";
import { Loading, LoadError } from "../components/LoadState";
import { useLoad } from "../lib/useLoad";
import { timeUntil } from "../lib/time";
import * as api from "../lib/api";
import type { VaultRequest } from "../components/VaultSheet";

export function SantaPage({
  askVault,
  toast,
}: {
  askVault: (request: VaultRequest) => void;
  toast: (message: string) => void;
}) {
  const staticRules = useLoad(api.getStaticRules);
  const rules = useLoad(api.getRules);
  const loosens = useLoad(api.getLoosenRequests);
  const installed = useLoad(() => api.getInstalledSoftware());
  const known = useLoad(api.getKnownApps);
  const [search, setSearch] = useState("");

  const pendingByRuleId = useMemo(
    () => new Map((loosens.data || []).map((p) => [p.rule_id, p])),
    [loosens.data]
  );

  const rulesLoaded = staticRules.data && rules.data && loosens.data;
  const rulesError = staticRules.error || rules.error || loosens.error;

  const reloadRules = () => {
    rules.reload();
    loosens.reload();
  };

  const requestLoosen = (ruleId: number, label: string) => {
    askVault({
      action: `un-block ${label}`,
      onSubmit: async (password) => {
        await api.requestLoosenRule(ruleId, password);
        reloadRules();
      },
    });
  };

  const cancelLoosen = async (id: number) => {
    await api.cancelLoosenRequest(id);
    loosens.reload();
  };

  // Installed-apps rows: known Apple apps pinned first (same reasoning
  // as dashboard.ts's own loadInstalledApps), then everything else Fleet
  // reported. Block/Allow both create a rule immediately (tightening
  // shape, no vault) - see lib/api.ts's createRule and this file's own
  // comment above requestLoosen for why that's correct, not an oversight.
  const appRows = useMemo(() => {
    if (!installed.data) return [];
    const byBundle = new Map((installed.data || []).filter((a) => a.bundle_identifier).map((a) => [a.bundle_identifier!, a]));
    const knownIds = new Set((known.data || []).map((k) => k.bundleId));
    const knownRows = (known.data || []).map(
      (k) => byBundle.get(k.bundleId) || { name: k.name, version: null, bundle_identifier: k.bundleId, identifier: null, rule_type: null }
    );
    const restRows = (installed.data || []).filter((a) => !a.bundle_identifier || !knownIds.has(a.bundle_identifier));
    const all = [...knownRows, ...restRows];
    return search ? all.filter((a) => a.name.toLowerCase().includes(search.toLowerCase())) : all;
  }, [installed.data, known.data, search]);

  const rule = async (identifier: string, ruleType: string, policy: "BLOCKLIST" | "ALLOWLIST", appName: string) => {
    try {
      await api.createRule(identifier, ruleType as never, policy, appName);
      toast(`${policy === "BLOCKLIST" ? "Blocked" : "Allowed"} ${appName}.`);
      reloadRules();
    } catch (err) {
      toast(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <Card style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>App control — Santa</div>
        <Note icon={Lock}>
          MONITOR mode - execution isn't denied by default. Rules below explicitly block or allow specific apps
          (by Team ID, certificate, binary hash, or signing ID); the Phase 2 content blocker is the real backstop
          against unknown apps, per this project's own deliberate design.
        </Note>

        {!rulesLoaded && !rulesError ? (
          <Loading />
        ) : rulesError && !rulesLoaded ? (
          <LoadError message={rulesError} onRetry={reloadRules} />
        ) : (
          <>
            <SectionTitle>Static rules (permanent, from santa-config.mobileconfig)</SectionTitle>
            {(staticRules.data || []).map((r, i, arr) => (
              <Row key={r.identifier} last={i === arr.length - 1}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: T.ink3, marginTop: 1, fontFamily: F.mono }}>
                    {r.identifier} · {r.rule_type}
                  </div>
                </div>
                <Pill tone={r.policy === "BLOCKLIST" ? "rose" : "mint"}>{r.policy}</Pill>
              </Row>
            ))}

            <SectionTitle>Dashboard rules · {(rules.data || []).length}</SectionTitle>
            {(rules.data || []).length === 0 ? (
              <div className="empty" style={{ fontSize: 13, color: T.ink3, padding: "8px 0" }}>
                No dashboard-added rules yet.
              </div>
            ) : (
              (rules.data || []).map((r, i, arr) => {
                const pending = pendingByRuleId.get(r.id);
                const canLoosen = r.policy !== "REMOVE" && !pending;
                const label = r.notification_app_name || r.identifier;
                return (
                  <Row key={r.id} last={i === arr.length - 1}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{label}</div>
                      <div style={{ fontSize: 12, color: T.ink3, marginTop: 1, fontFamily: F.mono }}>
                        {r.identifier} · {r.rule_type}
                      </div>
                    </div>
                    {pending ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Pill tone="amber">un-blocks {timeUntil(pending.applies_at)}</Pill>
                        <button
                          onClick={() => cancelLoosen(pending.id)}
                          style={{ background: "none", border: "none", color: T.ink3, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: F.body }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : canLoosen ? (
                      <button
                        onClick={() => requestLoosen(r.id, label)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          flexShrink: 0,
                          background: T.forest,
                          color: "#fff",
                          border: "none",
                          borderRadius: 999,
                          padding: "7px 14px",
                          fontSize: 12.5,
                          fontWeight: 700,
                          cursor: "pointer",
                          fontFamily: F.body,
                        }}
                      >
                        <Lock size={12} strokeWidth={2.6} /> {r.policy}
                      </button>
                    ) : (
                      <Pill tone="plain">Removed</Pill>
                    )}
                  </Row>
                );
              })
            )}
          </>
        )}
      </Card>

      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Installed apps (Fleet inventory)</div>
        <div style={{ position: "relative", marginBottom: 16 }}>
          <Search size={16} color={T.ink3} style={{ position: "absolute", left: 14, top: 13 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px 12px 40px",
              borderRadius: 12,
              border: `1.5px solid ${T.line2}`,
              background: T.page,
              fontSize: 14,
              color: T.ink,
              outline: "none",
              fontFamily: F.body,
            }}
          />
        </div>
        {installed.loading || known.loading ? (
          <Loading />
        ) : installed.error ? (
          <LoadError message={installed.error} onRetry={installed.reload} />
        ) : appRows.length === 0 ? (
          <div className="empty" style={{ fontSize: 13, color: T.ink3, padding: "8px 0" }}>
            No installed apps returned - Fleet may not have inventoried this host recently.
          </div>
        ) : (
          appRows.map((a, i, arr) => (
            <Row key={a.bundle_identifier || a.name} last={i === arr.length - 1}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{a.name}</div>
                <div style={{ fontSize: 12, color: T.ink3, marginTop: 1 }}>
                  {a.version || "—"}
                  {a.identifier ? ` · ${a.identifier} (${a.rule_type})` : " · no identifier available"}
                </div>
              </div>
              {a.identifier && a.rule_type ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => rule(a.identifier!, a.rule_type!, "BLOCKLIST", a.name)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: T.bright,
                      color: T.forest, border: "none", borderRadius: 999, padding: "7px 13px", fontSize: 12.5,
                      fontWeight: 700, cursor: "pointer", fontFamily: F.body,
                    }}
                  >
                    <ArrowUp size={12} strokeWidth={3} /> Block
                  </button>
                  <button
                    onClick={() => rule(a.identifier!, a.rule_type!, "ALLOWLIST", a.name)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, background: T.line,
                      color: T.ink2, border: "none", borderRadius: 999, padding: "7px 13px", fontSize: 12.5,
                      fontWeight: 700, cursor: "pointer", fontFamily: F.body,
                    }}
                  >
                    <Check size={12} strokeWidth={3} /> Allow
                  </button>
                </div>
              ) : null}
            </Row>
          ))
        )}
      </Card>
    </>
  );
}
