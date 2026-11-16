/** Local support history. Reuses the v2 records store; no database upgrade/reset. */
import {
  readSnapshot,
  writeSnapshot,
  profileFor,
  profileActive,
  type Profile,
} from "./cache";
export type LogLevel = "info" | "warning" | "error";
export type LogInput = {
  level?: LogLevel;
  module: string;
  action: string;
  message: string;
  object?: string;
  source?: string;
  code?: string;
  path?: string;
  elapsedMs?: number;
  requestId?: string;
  result?: "success" | "failure" | "recovery" | "info";
};
export type LogEntry = LogInput & {
  id: string;
  at: number;
  firstAt: number;
  count: number;
  relatedId?: string;
  webVersion?: string;
  appVersion?: string;
};
const MAX = 1000,
  AGE = 7 * 86400000,
  NAME = "application-logs-v1";
// Same safe representation is persisted, rendered, copied and exported.
export function safeLogText(value = "") {
  return value
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, "[Cookie已隐藏]")
    .replace(/https?:\/\/[^\s<>]+/gi, "[链接已省略]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[凭据已隐藏]")
    .replace(
      /(?:password|passwd|token|cookie|csrf|authorization|secret|api[_-]?key|密码|令牌)["']?\s*[=:：]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[凭据已隐藏]",
    )
    .replace(/([\w./%-]+)\?[^\s]+/g, "$1?[参数已隐藏]")
    .slice(0, 800);
}
export function pruneLogs(rows: LogEntry[], now = Date.now()) {
  return rows
    .filter((row) => row.at >= now - AGE)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX);
}
export function mergeLog(rows: LogEntry[], input: LogEntry) {
  const previous = rows[0];
  if (
    previous &&
    previous.module === input.module &&
    previous.action === input.action &&
    previous.object === input.object &&
    previous.source === input.source &&
    previous.path === input.path &&
    previous.code === input.code &&
    previous.level === input.level &&
    previous.result === input.result &&
    previous.message === input.message &&
    input.at - previous.at < 60000
  ) {
    return pruneLogs(
      [
        { ...previous, at: input.at, count: previous.count + input.count },
        ...rows.slice(1),
      ],
      input.at,
    );
  }
  if (input.result === "recovery")
    input.relatedId = rows.find(
      (row) =>
        row.level !== "info" &&
        row.module === input.module &&
        row.action === input.action &&
        row.object === input.object &&
        row.path === input.path,
    )?.id;
  return pruneLogs([input, ...rows], input.at);
}
type State = { rows: LogEntry[]; ready: boolean; memoryOnly: boolean };
type Bucket = {
  profile: Profile;
  state: State;
  loaded: boolean;
  loading?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  writing?: Promise<void>;
};
const buckets = new Map<string, Bucket>(),
  listeners = new Set<() => void>();
let profile = profileFor(location.origin, "anonymous"),
  webVersion = "",
  appVersion = "";
const key = (p: Profile) =>
  JSON.stringify([p.origin, p.subject, p.schema, p.generation || 0]);
const emit = () => listeners.forEach((fn) => fn());
function bucket(target = profile) {
  const id = key(target);
  let value = buckets.get(id);
  if (!value) {
    value = {
      profile: target,
      state: { rows: [], ready: false, memoryOnly: false },
      loaded: false,
    };
    buckets.set(id, value);
  }
  return value;
}
async function load(value: Bucket) {
  if (value.loaded) return;
  if (!value.loading)
    value.loading = (async () => {
      try {
        const stored = await readSnapshot<LogEntry[]>(value.profile, NAME);
        if (!profileActive(value.profile)) return;
        value.state = {
          ...value.state,
          rows: pruneLogs([...value.state.rows, ...(stored?.value || [])]),
        };
      } catch {
        value.state = { ...value.state, memoryOnly: true };
      } finally {
        value.loaded = true;
        value.state = { ...value.state, ready: true };
        emit();
      }
    })();
  await value.loading;
}
function persist(value: Bucket) {
  clearTimeout(value.timer);
  value.timer = setTimeout(() => {
    value.writing = (value.writing || Promise.resolve()).then(async () => {
      await load(value);
      if (!profileActive(value.profile)) return;
      value.state = { ...value.state, rows: pruneLogs(value.state.rows) };
      try {
        await writeSnapshot(value.profile, NAME, value.state.rows);
      } catch {
        value.state = { ...value.state, memoryOnly: true };
        emit();
      }
    });
  }, 80);
}
export function setLogProfile(value?: Profile) {
  profile = value || profileFor(location.origin, "anonymous");
  const current = bucket();
  void load(current).then(() => persist(current));
  emit();
}
export function refreshLogs() {
  const current = bucket();
  current.state = { ...current.state, rows: pruneLogs(current.state.rows) };
  emit();
  void load(current).then(() => persist(current));
}
export function setLogVersions(web?: string, app?: string) {
  if (web) webVersion = safeLogText(web);
  if (app) appVersion = safeLogText(app);
}
export function logEvent(input: LogInput, target = profile) {
  if (!profileActive(target) || key(target) !== key(profile)) return;
  const value = bucket(target);
  const row: LogEntry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    firstAt: Date.now(),
    count: 1,
    module: safeLogText(input.module),
    action: safeLogText(input.action),
    message: safeLogText(input.message),
    level: input.level || "info",
    result: input.result || "info",
    webVersion,
    appVersion,
  };
  for (const field of ["object", "source", "code", "requestId"] as const)
    if (input[field]) row[field] = safeLogText(input[field]);
  if (input.path)
    row.path = safeLogText(input.path.split(/[?#]/)[0]).replace(
      /[a-f0-9-]{32,}/gi,
      ":id",
    );
  if (Number.isFinite(input.elapsedMs)) row.elapsedMs = input.elapsedMs;
  value.state = { ...value.state, rows: mergeLog(value.state.rows, row) };
  emit();
  persist(value);
}
export function logFailure(
  module: string,
  action: string,
  error: unknown,
  object?: string,
  target = profile,
) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  logEvent(
    {
      module,
      action,
      object,
      message: error instanceof Error ? error.message : String(error),
      level: "error",
      result: "failure",
    },
    target,
  );
}
export const subscribeLogs = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const logSnapshot = () => bucket().state;
addEventListener("mw-mobile-local-cleared", () => {
  for (const value of buckets.values()) clearTimeout(value.timer);
  buckets.clear();
  profile = profileFor(location.origin, "anonymous");
  const current = bucket();
  // clearOrigin has fenced old profiles but its delete transaction is pending.
  // Start empty without reading records which are about to be deleted.
  current.loaded = true;
  current.state = { rows: [], ready: true, memoryOnly: false };
  emit();
});
