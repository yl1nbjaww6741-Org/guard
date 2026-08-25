import { useCallback, useEffect, useState } from "react";

// Minimal load-on-mount hook - per DASHBOARD-PROMPT.md's own tech-stack
// note ("fetch with useEffect + useState... keep dependencies minimal"),
// not a real data-fetching library. `reload` lets a page re-fetch after
// a mutation (add/remove/cancel) without a full page refresh, same
// pattern the existing dashboard.ts uses (its load* functions get
// re-invoked after every successful action).
export function useLoad<T>(loader: () => Promise<T>): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
