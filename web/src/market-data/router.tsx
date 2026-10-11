import { createContext, useContext, useEffect, useMemo, useRef, useCallback, type AnchorHTMLAttributes } from "react";
import { centerLocation } from "./location";
import type { ReturnContexts } from "./returnContext";

export type CenterNavigation = {
  workspace?: string;
  timezone?: string;
  returns?: ReturnContexts;
  location: string;
  navigate: (to: string, options?: { replace?: boolean; saved?: boolean }) => void;
  apply: (ticker: string, frame: string) => Promise<void>;
  setDirty: (key: string, dirty: boolean) => void;
  clearDirty: () => void;
  busy: boolean;
};
export const CenterContext = createContext<CenterNavigation | null>(null);
export function useCenter() {
  const value = useContext(CenterContext);
  if (!value) throw Error("数据中心需要窗口控制器");
  return value;
}
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}
/** React may batch two events before disabled reaches the DOM. */
export function useActionLock() {
  const pending = useRef(false);
  return useMemo(() => ({
    acquire() { if (pending.current) return false; pending.current = true; return true; },
    release() { pending.current = false; },
  }), []);
}
export function useNavigate() {
  const { navigate } = useCenter(), mounted = useMounted();
  // A submitted mutation may finish after its form was discarded. It must
  // never navigate a later form or clear that form's dirty state.
  return useCallback<CenterNavigation["navigate"]>((to, options) => {
    if (mounted.current) navigate(to, options);
  }, [navigate, mounted]);
}
export function useLocation() {
  const { location } = useCenter();
  return useMemo(() => { const url = new URL(location, "https://center.invalid"); return { pathname: url.pathname, search: url.search, hash: url.hash }; }, [location]);
}
export function useParams() {
  const { pathname } = useLocation();
  return { id: pathname.match(/^\/market-data\/(?:datasets|composites)\/([a-f0-9]{64})/)?.[1] };
}
export function useSearchParams(): [URLSearchParams, (next: URLSearchParams, options?: { replace?: boolean }) => void] {
  const location = useLocation(), navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  return [params, (next, options) => navigate(location.pathname + (next.size ? `?${next}` : "") + location.hash, options)];
}
export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const center = useCenter();
  return <a {...props} href={to} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // All management and replay actions remain under the same dirty guard.
    event.preventDefault();
    center.navigate(to);
  }} />;
}
export function useDirtyForm(key: string, values: unknown, saved: unknown = null) {
  const { setDirty } = useCenter();
  const signature = JSON.stringify(values);
  const baseline = useMemo(() => signature, [key, saved]);
  useEffect(() => { setDirty(key, signature !== baseline); return () => setDirty(key, false); }, [key, signature, baseline, setDirty]);
}
export { centerLocation };
