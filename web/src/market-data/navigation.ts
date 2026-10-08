import { useEffect, useRef } from "react";
import { useLocation } from "./router";

/** Preserve the originating center filter/page and a stable row on return. */
export function centerLink(path: string, params: URLSearchParams, row?: string) {
  const query = new URLSearchParams(params);
  query.delete("return_to");
  const back = "/market-data" + (query.size ? `?${query}` : "") + (row ? `#${row}` : "");
  const target = new URL(path, "http://internal");
  target.searchParams.set("return_to", back);
  return target.pathname + target.search;
}

export function centerReturn(params: URLSearchParams, fallback = "/market-data") {
  const value = params.get("return_to") || "";
  return /^\/market-data(?:\?[^#]*)?(?:#[^?]*)?$/.test(value) ? value : fallback;
}

export function useCenterRowRestore(snapshot: unknown) {
  const location = useLocation(), restored = useRef(false);
  useEffect(() => { restored.current = false; }, [location.pathname, location.search, location.hash]);
  useEffect(() => {
    if (restored.current || !snapshot) return;
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (location.hash && !target) return;
    restored.current = true;
    if (target) { target.scrollIntoView({block: "center"}); target.focus({preventScroll: true}); }
  }, [snapshot, location.hash]);
}
