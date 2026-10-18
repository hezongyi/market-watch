import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NoticeRuntime } from "./runtime";
const Context = createContext<NoticeRuntime | null>(null);
export function NoticeProvider({
  active,
  subject,
  children,
}: {
  active: boolean;
  subject: string;
  children: ReactNode;
}) {
  const [runtime] = useState(() => new NoticeRuntime());
  useLayoutEffect(() => {
    if (active && subject) void runtime.start(subject);
    else runtime.pause();
    return () => runtime.pause();
  }, [runtime, active, subject]);
  useEffect(() => () => runtime.dispose(), [runtime]);
  // The runtime survives all authenticated route and native sidebar changes.
  return <Context.Provider value={runtime}>{children}</Context.Provider>;
}
export function useNotices() {
  const runtime = useContext(Context);
  if (!runtime) throw Error("通知 Module 不在应用根部");
  return runtime;
}
export function useNoticeState() {
  const runtime = useNotices();
  return useSyncExternalStore(
    runtime.subscribe,
    runtime.snapshot,
    runtime.snapshot,
  );
}
