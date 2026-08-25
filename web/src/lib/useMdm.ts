import { useMemo } from "react";
import { useLoad } from "./useLoad";
import * as api from "./api";
import type { ConfigProfileDetail, MdmProfileStatus, PendingProfileChange } from "./types";

export interface MdmProfileRow {
  status: MdmProfileStatus;
  detail: ConfigProfileDetail | null;
  pendingChange: PendingProfileChange | null;
}

// Shared by the Fleet MDM and Chrome policy pages - same three real
// endpoints dashboard.ts's own loadHostStatus() already merges
// (host-status for Fleet's live per-profile verified/pending/failed
// status, config-profile-details for the hand-kept restriction-bullet
// mirror, pending-profile-changes for anything queued), matched by
// profile name exactly like the existing dashboard does.
export function useMdm() {
  const host = useLoad(api.getHostStatus);
  const details = useLoad(api.getConfigProfileDetails);
  const pendingChanges = useLoad(api.getPendingProfileChanges);

  const loading = host.loading || details.loading || pendingChanges.loading;
  const error = host.error || details.error || pendingChanges.error;

  const rows: MdmProfileRow[] = useMemo(() => {
    if (!host.data?.fleet?.mdm) return [];
    const detailsByName = new Map((details.data || []).map((d) => [d.name, d]));
    const pendingByUuid = new Map((pendingChanges.data || []).filter((p) => p.profile_uuid).map((p) => [p.profile_uuid, p]));
    return host.data.fleet.mdm.profiles.map((status) => ({
      status,
      detail: detailsByName.get(status.name) || null,
      pendingChange: pendingByUuid.get(status.profile_uuid) || null,
    }));
  }, [host.data, details.data, pendingChanges.data]);

  const reload = () => {
    host.reload();
    pendingChanges.reload();
  };

  return { rows, loading, error, fleet: host.data?.fleet ?? null, fleetError: host.data?.fleetError, reload };
}
