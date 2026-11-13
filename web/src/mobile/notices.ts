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
  const [popup, setPopup] = useState("");
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
    if (!profile) setPopup("");
  }, [profile]);
  useEffect(() => {
    if (!profile || !online || !foreground || !state.events.length) return;
    const identity = JSON.stringify(profile),
      events = state.events;
    // A cursor refresh may publish the same rows while the receipt transaction
    // commits. Serialize presentation claims; never mark seen then drop the popup.
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
          setPopup(
            `${candidates.length} 条未处理事件，请到告警或更多的记录中查看。关闭提示不代表已处理。`,
          );
      })
      .catch(() => {
        if (activeProfile.current === identity)
          setPopup("事件提示去重未能记住，请到记录查看");
      });
  }, [state.events, profile?.origin, profile?.subject, online, foreground]);
  return { runtime, state, popup, closePopup: () => setPopup("") };
}
