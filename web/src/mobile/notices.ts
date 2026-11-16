import { logEvent, logFailure } from "./logs";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NoticeRuntime } from "../notifications/runtime";
import { NoticeStore } from "../notifications/store";
import {
  openMobileDatabase,
  readSnapshot,
  writeSnapshot,
  type Profile,
} from "./cache";

/** Reuse notification-center cursor/receipt semantics in the single phone database. */
export function useMobileNotices(
  profile: Profile | undefined,
  online: boolean,
) {
  const [runtime] = useState(
    () => new NoticeRuntime(new NoticeStore(openMobileDatabase), true),
  );
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.snapshot,
    runtime.snapshot,
  );
  const [foreground, setForeground] = useState(!document.hidden);
  const queue = useRef(Promise.resolve());
  const activeProfile = useRef("");
  activeProfile.current =
    profile && online && foreground ? JSON.stringify(profile) : "";
  useEffect(() => {
    const visible = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useEffect(() => {
    if (profile && online && foreground)
      void runtime.start(
        JSON.stringify([profile.origin, profile.subject, profile.schema]),
      );
    else runtime.pause();
    return () => runtime.pause();
  }, [runtime, profile?.origin, profile?.subject, online, foreground]);
  useEffect(() => () => runtime.dispose(), [runtime]);
  useEffect(() => {
    if (!profile || !online || !foreground || !state.events.length) return;
    const identity = JSON.stringify(profile),
      events = state.events;
    // Local logging deduplication is independent of runtime receipts/handling.
    // A cursor refresh can publish the same rows while the local write commits.
    queue.current = queue.current
      .then(async () => {
        if (activeProfile.current !== identity) return;
        const seen = new Set(
          (await readSnapshot<string[]>(profile, "notice-popups"))?.value || [],
        );
        if (activeProfile.current !== identity) return;
        const candidates = events.filter(
          (row) =>
            row.attention &&
            !row.handled_at &&
            !row.backfill &&
            !seen.has(row.id),
        );
        if (!candidates.length) return;
        candidates.forEach((row) => seen.add(row.id));
        await writeSnapshot(profile, "notice-popups", [...seen].slice(-500));
        if (activeProfile.current === identity)
          logEvent({module:"告警",action:"收到服务器事件",message:`${candidates.length} 条未处理事件，详见告警记录`,level:"warning",object:candidates.map(row=>row.title).join(" · ")});
      })
      .catch(() => {
        if (activeProfile.current === identity)
          logFailure("告警","事件去重","事件日志去重未能记住，请到记录查看");
      });
  }, [state.events, profile?.origin, profile?.subject, online, foreground]);
  return { runtime, state };
}
