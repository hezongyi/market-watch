import { useEffect, useRef, useState } from "react";
import { api } from "../api";

export function useSnapshot<T>(path: string | null, refresh = 0) {
  const [snapshot, setSnapshot] = useState<{
    path: string;
    data: T;
    at: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current,
      abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setError("");
    if (!path) {
      setLoading(false);
      return () => abort.abort();
    }
    async function poll() {
      try {
        const data = await api<T>(path!, undefined, abort.signal);
        if (current === generation.current && !abort.signal.aborted) {
          setSnapshot({ path: path!, data, at: Date.now() });
          setError("");
        }
      } catch (e) {
        if (current === generation.current && !abort.signal.aborted)
          setError(String(e));
      } finally {
        if (current === generation.current && !abort.signal.aborted) {
          setLoading(false);
          timer = setTimeout(poll, 10000);
        }
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      generation.current++;
    };
  }, [path, refresh]);
  return {
    data: snapshot?.path === path ? snapshot.data : null,
    at: snapshot?.path === path ? snapshot.at : null,
    error,
    loading,
  };
}
