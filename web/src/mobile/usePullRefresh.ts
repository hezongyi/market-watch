import { useEffect, useRef, useState, type RefObject } from "react";

export const PULL_THRESHOLD = 56;
export function usePullRefresh(target: RefObject<HTMLDivElement | null>, enabled: boolean, refreshing: boolean, refresh: () => void) {
  const [distance, setDistance] = useState(0);
  const current = useRef({ refreshing, refresh });
  current.current = { refreshing, refresh };
  useEffect(() => {
    const node = target.current;
    if (!node || !enabled) { setDistance(0); return; }
    let start: {x:number;y:number} | undefined, amount = 0;
    const reset = () => { start = undefined; amount = 0; setDistance(0); };
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 1 || node.scrollTop > 0 || current.current.refreshing) return reset();
      const point = event.touches[0]; start = {x:point.clientX,y:point.clientY};
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) return reset();
      const point = event.touches[0], dy = point.clientY-start.y, dx = Math.abs(point.clientX-start.x);
      if (dy <= 0 || dx > dy) return reset();
      if (dy < 8) return;
      if (event.cancelable) event.preventDefault();
      amount = Math.min(84, dy * 0.45); setDistance(amount);
    };
    const end = () => {
      const ready = amount >= PULL_THRESHOLD; reset();
      if (ready && !current.current.refreshing) current.current.refresh();
    };
    node.addEventListener("touchstart", begin, {passive:true});
    node.addEventListener("touchmove", move, {passive:false});
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", reset);
    return () => {
      node.removeEventListener("touchstart", begin); node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end); node.removeEventListener("touchcancel", reset);
    };
  }, [target, enabled]);
  return distance;
}
