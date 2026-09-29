import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  /** True while a load is in flight (also during reloads, keeping the previous data). */
  loading: boolean;
  reload(): void;
}

/** Runs `load` when `deps` change; ignores results of stale runs. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const run = useRef(0);
  const lastTick = useRef(-1);

  useEffect(() => {
    const id = ++run.current;
    // New inputs (not a reload): never show the previous inputs' data.
    if (lastTick.current === tick) setData(undefined);
    lastTick.current = tick;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (id !== run.current) return;
        setData(value);
        setLoading(false);
      },
      (err: unknown) => {
        if (id !== run.current) return;
        console.warn(err);
        setError(err ?? new Error('Error'));
        setLoading(false);
      },
    );
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
