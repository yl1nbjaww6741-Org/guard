import { useMemo } from "react";
import { ArrowUp, ArrowDown, Globe, Server, Check, Clock } from "lucide-react";
import { tokens as T } from "../lib/tokens";
import { Card } from "../components/Card";
import { Row } from "../components/Row";
import { Pill } from "../components/Pill";
import { Loading, LoadError } from "../components/LoadState";
import { useLoad } from "../lib/useLoad";
import { timeAgo, timeUntil } from "../lib/time";
import * as api from "../lib/api";

const SANTA_STALE_MS = 30 * 60 * 1000;

export function HomePage() {
  const host = useLoad(api.getHostStatus);
  const loosens = useLoad(api.getLoosenRequests);
  const safeAppAdditions = useLoad(api.getSafeAppAdditions);
  const profileChanges = useLoad(api.getPendingProfileChanges);
  const officePasswordChange = useLoad(api.getPendingOfficePasswordChange);

  const anyLoading = host.loading || loosens.loading || safeAppAdditions.loading || profileChanges.loading || officePasswordChange.loading;
  const firstError = host.error || loosens.error || safeAppAdditions.error || profileChanges.error || officePasswordChange.error;

  const pendingRows = useMemo(() => {
    const rows: { label: string; appliesAt: number }[] = [];
    (loosens.data || []).forEach((p) => rows.push({ label: `Un-block Santa rule #${p.rule_id}`, appliesAt: p.applies_at }));
    (safeAppAdditions.data || []).forEach((p) =>
      rows.push({ label: `Whitelist ${p.name || p.bundle_id}`, appliesAt: p.applies_at })
    );
    (profileChanges.data || []).forEach((p) =>
      rows.push({
        label: p.action === "create" ? `Upload profile "${p.filename || "new"}"` : `Update profile "${p.filename || p.profile_uuid}"`,
        appliesAt: p.applies_at,
      })
    );
    if (officePasswordChange.data) rows.push({ label: "Change office password", appliesAt: officePasswordChange.data.applies_at });
    return rows.sort((a, b) => a.appliesAt - b.appliesAt);
  }, [loosens.data, safeAppAdditions.data, profileChanges.data, officePasswordChange.data]);

  return (
    <>
      <Card dark style={{ padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.bright, letterSpacing: "0.05em", textTransform: "uppercase" }}>
          How changes work
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: "-0.03em", lineHeight: 1.25, margin: "10px 0 16px" }}>
          Tighten anything instantly.
          <br />
          Loosening takes a day.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: T.bright,
              color: T.forest,
              borderRadius: 999,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            <ArrowUp size={13} strokeWidth={3} /> Tighten — one tap
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(255,255,255,0.12)",
              color: "#fff",
              borderRadius: 999,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            <ArrowDown size={13} strokeWidth={3} /> Loosen — office password + 24h
          </span>
        </div>
      </Card>

      <Card style={{ padding: "18px 18px 8px", marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>System health</div>
        {anyLoading && !host.data ? (
          <Loading />
        ) : firstError && !host.data ? (
          <LoadError message={firstError} onRetry={host.reload} />
        ) : host.data ? (
          <>
            <Row last={host.data.devices.length === 0}>
              <span style={{ width: 36, height: 36, borderRadius: 11, background: T.mint, display: "grid", placeItems: "center", flexShrink: 0 }}>
                <Server size={17} color={T.mintInk} strokeWidth={2.2} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>Fleet</div>
                <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2 }}>
                  {host.data.fleet
                    ? `${host.data.fleet.status}, last seen ${timeAgo(host.data.fleet.seen_time)}`
                    : host.data.fleetError || "not available"}
                </div>
              </div>
              <Pill tone={host.data.fleet?.status === "online" ? "mint" : "rose"} icon={host.data.fleet?.status === "online" ? Check : undefined}>
                {host.data.fleet?.status === "online" ? "On" : "Off"}
              </Pill>
            </Row>
            {host.data.devices.map((d, i, arr) => {
              const stale = !d.last_preflight_at || Date.now() - d.last_preflight_at > SANTA_STALE_MS;
              return (
                <Row key={d.machine_id} last={i === arr.length - 1}>
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 11,
                      background: stale ? T.rose : T.mint,
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Globe size={17} color={stale ? T.roseInk : T.mintInk} strokeWidth={2.2} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>Santa ({d.hostname || d.machine_id})</div>
                    <div style={{ fontSize: 12.5, color: T.ink3, marginTop: 2 }}>
                      {d.client_mode}, last synced {d.last_preflight_at ? timeAgo(d.last_preflight_at) : "never"}
                    </div>
                  </div>
                  <Pill tone={stale ? "rose" : "mint"} icon={stale ? undefined : Check}>
                    {stale ? "Stale" : "On"}
                  </Pill>
                </Row>
              );
            })}
          </>
        ) : null}
      </Card>

      <Card style={{ padding: "18px 18px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <Clock size={16} color={T.ink3} strokeWidth={2.2} />
          <span style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>Pending changes</span>
          <Pill tone="plain">{pendingRows.length}</Pill>
        </div>
        {anyLoading && pendingRows.length === 0 ? (
          <Loading />
        ) : pendingRows.length === 0 ? (
          <div style={{ padding: "20px 16px", textAlign: "center", background: T.page, borderRadius: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 3 }}>Queue is empty</div>
            <div style={{ fontSize: 13, color: T.ink3 }}>Loosening requests show up here with a countdown until they apply.</div>
          </div>
        ) : (
          pendingRows.map((p, i, arr) => (
            <Row key={p.label + i} last={i === arr.length - 1} pad="10px 0">
              <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: T.ink2 }}>{p.label}</div>
              <Pill tone="amber" icon={Clock}>
                {timeUntil(p.appliesAt)}
              </Pill>
            </Row>
          ))
        )}
      </Card>
    </>
  );
}
