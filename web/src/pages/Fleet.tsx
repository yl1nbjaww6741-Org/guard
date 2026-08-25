import { tokens as T } from "../lib/tokens";
import { Card } from "../components/Card";
import { Grid } from "../components/Grid";
import { Stat } from "../components/Stat";
import { Note } from "../components/Note";
import { MdmProfileCard } from "../components/MdmProfileCard";
import { Loading, LoadError } from "../components/LoadState";
import { useMdm } from "../lib/useMdm";
import { timeAgo } from "../lib/time";
import { Server } from "lucide-react";

export function FleetPage() {
  const { rows, loading, error, fleet, fleetError, reload } = useMdm();

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: T.ink, marginBottom: 14 }}>Fleet MDM</div>

      {loading && !fleet ? (
        <Loading />
      ) : !fleet ? (
        <LoadError message={fleetError || error || "Fleet not available"} onRetry={reload} />
      ) : (
        <>
          <Grid cols={130}>
            <Stat label="Connection" value={fleet.status} good={fleet.status === "online"} />
            <Stat label="Last check-in" value={timeAgo(fleet.seen_time)} />
            <Stat label="Disk encryption" value={fleet.disk_encryption_enabled === null ? "Unknown" : fleet.disk_encryption_enabled ? "On" : "Off"} good={fleet.disk_encryption_enabled === true} />
            <Stat label="Profiles active" value={String(fleet.mdm?.profiles.length ?? 0)} />
            <Stat label="Enrollment" value={fleet.mdm?.enrollment_status ?? "—"} good={fleet.mdm?.connected_to_fleet} />
          </Grid>
          <Note icon={Server}>
            Fleet runs on Fly.io behind a Cloudflare Tunnel. If Fleet goes down, existing restrictions stay
            enforced - you just can't push changes until it's back.
          </Note>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.ink3, textTransform: "uppercase", letterSpacing: "0.06em", margin: "4px 0 4px" }}>
            Active profiles
          </div>
          {rows.length === 0 ? (
            <div style={{ fontSize: 13, color: T.ink3, padding: "8px 0" }}>No configuration profiles reported by Fleet.</div>
          ) : (
            rows.map((row) => <MdmProfileCard key={row.status.profile_uuid} row={row} onQueued={reload} />)
          )}
        </>
      )}
    </Card>
  );
}
