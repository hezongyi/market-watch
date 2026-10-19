import { api, ApiError } from "../api";
import { NoticeStore } from "./store";
import type {
  BrowserFault,
  Intake,
  Notice,
  NoticeAction,
  NoticeState,
  HistoryPage,
} from "./types";

const base = "/notification-center";
const initial: NoticeState = {
  epoch: "",
  revision: 0,
  events: [],
  pending: [],
  unread: 0,
  status: "尚未连接",
  gap: "",
  enabled: false,
  unlocked: false,
  soundLimited: false,
  soundStatus: "网页声音未启用",
  systemPopups: true,
  bubble: null,
  overflow: 0,
  serverTime: 0,
};
const rank: Record<string, number> = {
  critical: 3,
  error: 2,
  warning: 1,
  info: 0,
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function scrub(value: any, depth = 0): any {
  if (depth > 6) return "[深层证据已省略]";
  if (typeof value === "string")
    return value
      .replace(/https?:\/\/[^\s]+/g, "[地址已隐藏]")
      .replace(
        /(bearer\s+|(?:token|password|csrf|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[已隐藏]",
      )
      .slice(0, 2000);
  if (Array.isArray(value))
    return value.slice(0, 30).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .filter(
          ([key]) =>
            !/(password|secret|authorization|cookie|csrf|token)/i.test(key),
        )
        .map(([key, v]) => [key.slice(0, 100), scrub(v, depth + 1)]),
    );
  return value;
}
async function stableId(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const h = [...bytes.slice(0, 16)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20)
  );
}
export class NoticeRuntime {
  state = { ...initial };
  private listeners = new Set<() => void>();
  private store = new NoticeStore();
  private startup: Promise<void> | null = null;
  private faultIngress: Promise<void> = Promise.resolve();
  private subject = "";
  private generation = 0;
  private profile = "";
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private working = false;
  private channel: BroadcastChannel | null = null;
  private audio: AudioContext | null = null;
  private after = "";
  private epoch = "";
  private errorCount = 0;
  private uploadErrors = 0;
  private nextUpload = 0;
  private nextHealth = 0;
  private nextPrune = 0;
  private serverAnchor = 0;
  private monoAnchor = 0;
  private soundAllowed = false;
  private queue: Notice[] = [];
  private candidates = new Map<string, Notice>();
  private presentation = false;
  private displayEnabled = true;
  private popping = false;
  private attached = false;
  private faultListener = (event: Event) => {
    if (this.ready)
      void this.report((event as CustomEvent<BrowserFault>).detail);
  };
  private expired = () => this.pause();
  private visibility = () => {
    if (document.visibilityState === "visible") {
      void this.playCandidates();
      void this.pop();
    }
  };
  private attach() {
    if (this.attached) return;
    this.attached = true;
    addEventListener("mw-notice-fault", this.faultListener);
    addEventListener("mw-session-expired", this.expired);
    document.addEventListener("visibilitychange", this.visibility);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private patch(value: Partial<NoticeState>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private current(generation: number) {
    return !!this.subject && generation === this.generation;
  }
  pause() {
    this.generation++;
    this.subject = "";
    this.ready = false;
    this.working = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.channel?.close();
    this.channel = null;
    this.queue = [];
    this.candidates.clear();
    this.after = "";
    this.epoch = "";
    this.nextUpload = 0;
    this.uploadErrors = 0;
    this.presentation = false;
    void this.audio?.suspend().catch(() => {});
    this.patch({ ...initial });
  }
  dispose() {
    this.pause();
    this.attached = false;
    removeEventListener("mw-notice-fault", this.faultListener);
    removeEventListener("mw-session-expired", this.expired);
    document.removeEventListener("visibilitychange", this.visibility);
  }
  start(subject: string) {
    this.startup = this.initialize(subject);
    return this.startup;
  }
  private async initialize(subject: string) {
    this.attach();
    this.pause();
    this.subject = subject;
    const generation = this.generation;
    try {
      await this.store.open();
      if (!this.current(generation)) return;
      const proposal = crypto.randomUUID();
      const profile = await this.store.update(
        "meta",
        "global:profile",
        "global",
        (old) => (old === undefined ? proposal : undefined),
      );
      if (!this.current(generation)) return;
      this.profile = profile || proposal;
      const cached = await this.store.get("cache", subject),
        progress = await this.store.get("meta", subject + ":progress");
      let enabled = await this.store.get("meta", subject + ":sound");
      if (enabled === undefined) {
        try {
          enabled = localStorage.getItem("mw.web-sound") === "on";
        } catch {
          enabled = false;
        }
        await this.store.update(
          "meta",
          subject + ":sound",
          subject,
          () => !!enabled,
        );
      }
      const pruned = await this.store.prune(subject);
      this.nextPrune = performance.now() + 60000;
      if (!this.current(generation)) return;
      if (pruned.lost) {
        const gap = `${pruned.lost} 条本机待同步记录超过七天，未能保存到服务器（最早 ${new Date(pruned.from!).toLocaleString()}）`;
        await this.store.update("meta", subject + ":gap", subject, () => gap);
      }
      const gap = await this.store.get("meta", subject + ":gap");
      const systemPopups = await this.store.get(
        "meta",
        subject + ":system-popups",
      );
      if (!this.current(generation)) return;
      this.ready = true;
      this.after = progress?.after || "";
      this.epoch = progress?.epoch || "";
      this.patch({
        epoch: this.epoch,
        events: cached || [],
        unread: progress?.unread || 0,
        enabled: !!enabled,
        systemPopups: systemPopups !== false,
        gap: gap || "",
        status: "正在同步",
        soundLimited: !navigator.locks,
        soundStatus: enabled ? "需要浏览器手势解锁" : "网页声音未启用",
      });
      if (typeof BroadcastChannel !== "undefined") {
        this.channel = new BroadcastChannel("mw-chart-notices");
        this.channel.onmessage = (event) => {
          if (
            event.data?.subject === this.subject &&
            event.data.type === "sound"
          )
            this.patch({ enabled: !!event.data.enabled });
          if (
            event.data?.subject === this.subject &&
            event.data.type === "system-popups"
          )
            this.applySystemPopups(event.data.enabled !== false);
        };
      }
      await this.loadPending(generation);
      for (const claim of await this.store.all("claims", subject)) {
        if (
          claim.key.startsWith(subject + ":sound:") &&
          claim.value.state === "reserved"
        ) {
          await this.store.update("claims", claim.key, subject, () => ({
            state: "unknown",
          }));
          if (this.current(generation))
            void this.observation(
              claim.key.split(":").slice(-2).join(":"),
              "sound_unknown",
              { reason: "预留后页面退出，结果未知；不会自动重试" },
            );
        }
      }
      void this.cycle(generation);
    } catch (error) {
      if (this.current(generation))
        this.patch({
          status: "本机持久存储不可用",
          gap: "新增故障未能持久保存：" + String(error),
          soundLimited: true,
        });
    }
  }
  setPresentation(visible: boolean) {
    this.presentation = visible;
    if (visible) void this.pop();
  }
  private estimateNow() {
    return this.serverAnchor
      ? this.serverAnchor + Math.max(0, performance.now() - this.monoAnchor)
      : Infinity;
  }
  private clock(at: number, uncertainty = 0) {
    this.serverAnchor = at + Math.max(0, uncertainty);
    this.monoAnchor = performance.now();
    this.patch({ serverTime: at });
  }
  private async loadPending(generation: number) {
    const rows = await this.store.all("pending", this.subject);
    if (!this.current(generation)) return;
    this.patch({
      pending: rows
        .filter((row) => !row.value.event.recovery_of)
        .slice(-200)
        .map((row) => this.localNotice(row.value.event, row.value.status)),
    });
  }
  private localNotice(event: Intake, status: string): Notice {
    return {
      id: event.event_id,
      version: 0,
      first_seq: 0,
      source_domain: "pro_chart",
      source_kind: event.source_kind,
      source_id: event.attempt_id,
      incident_id: "",
      kind: "failure",
      severity: event.severity || "error",
      title: event.title,
      message: event.message,
      occurred_at: event.occurred_at,
      recorded_at: 0,
      viewed_at: null,
      handled_at: null,
      attention: true,
      backfill: false,
      workspace: String(event.context.workspace_id || ""),
      instrument: String(event.context.instrument || ""),
      context: event.context,
      evidence: event.evidence,
      local_status: status,
      client_reported_time: true,
    };
  }
  private ingest<T>(run: () => Promise<T>, cancelled: T): Promise<T> {
    const generation = this.generation;
    const next = this.faultIngress.then(() =>
      this.current(generation) ? run() : cancelled,
    );
    // Producer callbacks may report failure and recovery without awaiting each
    // other. Serialize before hashes/IDB reads, not merely during upload.
    this.faultIngress = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  report(fault: BrowserFault): Promise<string | null> {
    return this.ingest(() => this.recordFault(fault), null);
  }
  private async recordFault(fault: BrowserFault): Promise<string | null> {
    const generation = this.generation,
      subject = this.subject;
    if (!this.ready && subject && this.startup) await this.startup;
    if (!this.ready || !subject || !this.current(generation)) return null;
    try {
      if (
        !fault ||
        !fault.attempt_id ||
        !/^[A-Z0-9_:.-]{1,80}$/.test(fault.code)
      )
        throw Error("故障来源身份无效");
      const id =
        "b:" +
        (await stableId(
          [subject, this.profile, fault.source_kind, fault.attempt_id].join(
            "|",
          ),
        ));
      if (!this.current(generation)) return null;
      const existing = await this.store.get("pending", subject + ":" + id);
      if (existing) return id;
      // The occurrence claim survives successful upload, so effect/bridge replay is inert.
      const prior = await this.store.get(
        "claims",
        subject + ":occurrence:" + id,
      );
      if (prior) return id;
      const event = scrub({
        source_kind: fault.source_kind,
        attempt_id: fault.attempt_id,
        code: fault.code,
        title: fault.title,
        message: fault.message,
        schema_version: 1,
        event_id: id,
        profile: this.profile,
        occurred_at: Date.now(),
        severity: fault.severity || "error",
        context: fault.context || {},
        evidence: fault.evidence || {},
      }) as Intake;
      await this.store.stage(subject, event);
      await this.store.update(
        "claims",
        subject + ":occurrence:" + id,
        subject,
        (old) => (old ? undefined : { id }),
      );
      if (!this.current(generation)) return null;
      const grouping = JSON.stringify([
        fault.source_kind,
        fault.code,
        ...[
          "workspace_id",
          "chart_index",
          "instrument",
          "timeframe",
          "consumer",
          "source_id",
          "endpoint",
        ].map((k) => event.context[k] ?? ""),
      ]);
      const groupKey = subject + ":fault:" + (await stableId(grouping));
      const old = await this.store.update("meta", groupKey, subject, (old) => ({
        latest: id,
        open: true,
      }));
      if (!this.current(generation)) return null;
      const notice = this.localNotice(event, "pending");
      this.patch({
        pending: [
          ...this.state.pending.filter((r) => r.id !== id),
          notice,
        ].slice(-200),
      });
      if (!old?.open) this.enqueue(notice);
      this.schedule(generation, 0);
      return id;
    } catch (error) {
      if (this.current(generation)) {
        const gap = "新增通知未能保存：" + String(error);
        this.patch({ gap, status: "本机存储受限" });
        try {
          await this.store.update("meta", subject + ":gap", subject, () => gap);
        } catch {
          /* Immediate truthful local degradation remains visible. */
        }
      }
      return null;
    }
  }
  async recovered(fault: BrowserFault, eventId: string) {
    const generation = this.generation,
      subject = this.subject;
    if (!this.ready || !eventId) return;
    const event = scrub({
      ...fault,
      schema_version: 1,
      event_id: "b:" + crypto.randomUUID(),
      profile: this.profile,
      occurred_at: Date.now(),
      severity: "info",
      context: fault.context || {},
      evidence: fault.evidence || {},
      recovery_of: eventId,
    });
    try {
      await this.store.stage(subject, event);
      const grouping = JSON.stringify([
        fault.source_kind,
        fault.code,
        ...[
          "workspace_id",
          "chart_index",
          "instrument",
          "timeframe",
          "consumer",
          "source_id",
          "endpoint",
        ].map((k) => event.context[k] ?? ""),
      ]);
      const groupKey = subject + ":fault:" + (await stableId(grouping));
      await this.store.update("meta", groupKey, subject, (old) =>
        old?.latest === eventId ? { ...old, open: false } : undefined,
      );
      if (this.current(generation)) this.schedule(generation, 0);
    } catch (error) {
      if (this.current(generation))
        this.patch({ gap: "恢复事实尚未保存：" + String(error) });
    }
  }
  resolve(fault: BrowserFault): Promise<void> {
    return this.ingest(() => this.resolveFault(fault), undefined);
  }
  private async resolveFault(fault: BrowserFault) {
    if (!this.ready) return;
    const generation = this.generation,
      subject = this.subject;
    const context = scrub(fault.context || {});
    const grouping = JSON.stringify([
      fault.source_kind,
      fault.code,
      ...[
        "workspace_id",
        "chart_index",
        "instrument",
        "timeframe",
        "consumer",
        "source_id",
        "endpoint",
      ].map((k) => context[k] ?? ""),
    ]);
    const key = subject + ":fault:" + (await stableId(grouping));
    try {
      const group = await this.store.get("meta", key);
      if (this.current(generation) && group?.open)
        await this.recovered({ ...fault, context }, group.latest);
    } catch (error) {
      if (this.current(generation))
        this.patch({
          gap: "操作已成功，通知恢复事实尚未保存：" + String(error),
        });
    }
  }
  async operation<T>(fault: BrowserFault, run: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (
        this.current(generation) &&
        !(error instanceof ApiError && error.status === 401) &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        await this.report({ ...fault, message: String(error) });
      throw error;
    }
    // A committed business operation stays successful even if telemetry fails.
    try {
      if (this.current(generation)) await this.resolve(fault);
    } catch (error) {
      if (this.current(generation))
        this.patch({
          gap: "操作已成功，通知恢复事实尚未保存：" + String(error),
        });
    }
    return result;
  }
  private enqueue(event: Notice) {
    if (
      event.source_kind !== "chart_alert" &&
      (!this.state.systemPopups || event.severity === "info")
    )
      return;
    if (
      !this.displayEnabled ||
      (!event.local_status &&
        this.estimateNow() - (event.accepted_at ?? event.occurred_at) > 30000)
    )
      return;
    if (
      event.backfill ||
      !event.attention ||
      this.queue.some((row) => row.id === event.id) ||
      this.state.bubble?.id === event.id
    )
      return;
    this.queue.push(event);
    this.queue.sort(
      (a, b) =>
        (rank[b.severity] || 0) - (rank[a.severity] || 0) ||
        a.occurred_at - b.occurred_at,
    );
    if (this.queue.length > 20) {
      this.queue.pop();
      this.patch({ overflow: this.state.overflow + 1 });
    }
    void this.pop();
  }
  private async pop() {
    const generation = this.generation,
      subject = this.subject;
    if (
      this.popping ||
      !subject ||
      !this.presentation ||
      document.visibilityState !== "visible" ||
      this.state.bubble
    )
      return;
    this.popping = true;
    try {
      while (this.queue.length && this.current(generation)) {
        const event = this.queue.shift()!;
        if (
          !event.local_status &&
          this.estimateNow() - (event.accepted_at ?? event.occurred_at) > 30000
        )
          continue;
        const prior = await this.store.update(
          "claims",
          subject + ":bubble:" + event.id,
          subject,
          (old) => (old ? undefined : { reserved: true }),
        );
        if (!prior && this.current(generation)) {
          this.patch({ bubble: event });
          break;
        }
      }
    } catch (error) {
      if (this.current(generation))
        this.patch({ gap: "即时提示去重存储不可用：" + String(error) });
    } finally {
      this.popping = false;
    }
  }
  dismiss() {
    this.patch({ bubble: null });
    void this.pop();
  }
  private async observation(
    eventId: string,
    kind: string,
    details: Record<string, unknown> = {},
    explicit = false,
  ) {
    const generation = this.generation,
      subject = this.subject;
    if (!this.ready) return;
    const id = explicit
      ? crypto.randomUUID()
      : await stableId([subject, this.profile, eventId, kind].join("|"));
    if (!this.current(generation)) return;
    const key = subject + ":obs:" + id;
    const value = {
      observation_id: id,
      event_id: eventId,
      profile: this.profile,
      kind,
      reported_at: Date.now(),
      details,
    };
    try {
      const previous = await this.store.update(
        "observations",
        key,
        subject,
        (old) => (old ? undefined : { value, pending: true }),
      );
      if (!previous && this.current(generation)) this.schedule(generation, 0);
    } catch (error) {
      if (this.current(generation))
        this.patch({ gap: "网页观察尚未保存：" + String(error) });
    }
  }
  rendered(eventId: string) {
    return this.observation(eventId, "rendered", {
      visibility: "页面与展示元素可见；不代表人已看见",
    });
  }
  private schedule(generation: number, ms: number) {
    if (!this.current(generation)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.cycle(generation);
    }, ms);
  }
  private async cycle(generation: number) {
    if (!this.current(generation) || !this.ready || this.working) return;
    this.working = true;
    const subject = this.subject;
    try {
      if (!this.after) {
        const requestStarted = performance.now();
        const page = await api<HistoryPage>(base + "/events");
        if (!this.current(generation)) return;
        this.clock(page.server_time, performance.now() - requestStarted);
        await this.store.saveProgress(
          subject,
          page.after,
          page.epoch,
          page.events,
          page.system_unread ?? page.unread,
        );
        if (!this.current(generation)) return;
        this.after = page.after;
        this.epoch = page.epoch;
        this.patch({
          events: page.events,
          unread: page.system_unread ?? page.unread,
          epoch: page.epoch,
        });
      }
      let more = false;
      for (let batch = 0; batch < 10; batch++) {
        const requestStarted = performance.now();
        const result = await api(
          base + "/changes?after=" + encodeURIComponent(this.after),
        );
        if (!this.current(generation)) return;
        this.clock(result.server_time, performance.now() - requestStarted);
        const rows = new Map(this.state.events.map((row) => [row.id, row]));
        const candidates: Notice[] = [];
        for (const change of result.changes) {
          if (change.kind === "deleted") {
            rows.delete(change.event_id);
            continue;
          }
          if (change.kind === "incident") {
            for (const [id, row] of rows)
              if (row.incident_id === change.body.id)
                rows.set(id, { ...row, incident: change.body });
            continue;
          }
          const event = change.body as Notice;
          if (
            !rows.has(event.id) ||
            rows.get(event.id)!.version < event.version
          )
            rows.set(event.id, event);
          if (event.incident)
            for (const [id, row] of rows)
              if (row.incident_id === event.incident_id)
                rows.set(id, { ...row, incident: event.incident });
          if (change.kind === "created") candidates.push(event);
        }
        const events = [...rows.values()]
          .sort(
            (a, b) => b.occurred_at - a.occurred_at || b.id.localeCompare(a.id),
          )
          .slice(0, 200);
        const unread =
          result.system_unread ?? result.unread ?? this.state.unread;
        // Persist records and progress together before advancing the recovery cursor.
        await this.store.saveProgress(
          subject,
          result.after,
          result.epoch,
          events,
          unread,
          result.changes
            .filter(
              (change: any) =>
                change.kind === "created" ||
                change.kind === "updated" ||
                change.kind === "deleted",
            )
            .map((change: any) => change.event_id),
        );
        if (!this.current(generation)) return;
        this.after = result.after;
        this.epoch = result.epoch;
        this.patch({
          epoch: result.epoch,
          events,
          unread,
          revision: this.state.revision + (result.changes.length ? 1 : 0),
        });
        for (const event of candidates) {
          void this.observation(event.id, "received");
          this.enqueue(event);
          if (
            event.kind === "alert" &&
            event.attention &&
            !event.backfill &&
            event.notify_web !== false
          ) {
            this.candidates.set(event.id, event);
            if (this.candidates.size > 200)
              this.candidates.delete(this.candidates.keys().next().value!);
          }
        }
        more = result.more;
        if (!more) break;
      }
      if (this.nextHealth > 0) void this.playCandidates();
      // Projection acknowledgement is independent of the 200-summary window.
      for (const item of (await this.store.all("pending", subject))
        .filter(
          (row) =>
            row.value.status === "accepted" &&
            (row.value.nextCheck || 0) <= Date.now(),
        )
        .slice(0, 10)) {
        if (!this.current(generation)) return;
        try {
          await api(
            base + "/events/" + encodeURIComponent(item.value.event.event_id),
            undefined,
            AbortSignal.timeout(2000),
          );
          if (!this.current(generation)) return;
          await this.store.remove("pending", item.key);
        } catch (error) {
          if (!this.current(generation)) return;
          if (error instanceof ApiError && error.status === 401) throw error;
          await this.store.update("pending", item.key, subject, (old) =>
            old ? { ...old, nextCheck: Date.now() + 30000 } : undefined,
          );
          if (!(error instanceof ApiError && error.status === 404)) break;
        }
      }
      // Live consumption has priority. A poison intake must never block it.
      const pending = await this.store.all("pending", subject);
      for (const item of pending
        .filter(
          (r) =>
            r.value.status === "pending" &&
            performance.now() >= this.nextUpload,
        )
        .sort((a, b) => (a.order ?? a.at) - (b.order ?? b.at))
        .slice(0, 10)) {
        if (!this.current(generation)) return;
        try {
          await api(
            base + "/events",
            item.value.event,
            AbortSignal.timeout(2000),
          );
          if (!this.current(generation)) return;
          if (item.value.event.recovery_of) {
            // Recovery intake closes its incident without creating an event
            // under the recovery ID. Durable acceptance completes this upload.
            await this.store.remove("pending", item.key);
          } else {
            await this.store.update("pending", item.key, subject, (old) =>
              old ? { ...old, status: "accepted" } : undefined,
            );
          }
          this.uploadErrors = 0;
        } catch (error) {
          if (!this.current(generation)) return;
          if (error instanceof ApiError && error.status === 401) throw error;
          if (
            error instanceof ApiError &&
            [400, 409, 413, 422].includes(error.status)
          ) {
            await this.store.update("pending", item.key, subject, (old) =>
              old
                ? { ...old, status: "rejected", rejection: String(error) }
                : undefined,
            );
            this.patch({
              gap: "有本机通知被服务端拒绝，未保存到服务器；证据仍保留在本机",
            });
            continue;
          }
          this.patch({ status: "本机记录待同步，服务端通知继续接收" });
          this.nextUpload =
            performance.now() +
            Math.min(60000, 1000 * 2 ** Math.min(6, ++this.uploadErrors)) *
              (0.8 + Math.random() * 0.4);
          break;
        }
      }
      const observations = await this.store.all("observations", subject);
      for (const item of observations
        .filter(
          (r) => r.value.pending && (r.value.nextCheck || 0) <= Date.now(),
        )
        .slice(0, 10)) {
        if (!this.current(generation)) return;
        try {
          await api(
            base + "/observations",
            item.value.value,
            AbortSignal.timeout(2000),
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            await this.store.update("observations", item.key, subject, (old) =>
              old ? { ...old, nextCheck: Date.now() + 30000 } : undefined,
            );
            continue;
          }
          if (error instanceof ApiError && error.status === 401) throw error;
          if (
            error instanceof ApiError &&
            [400, 409, 413, 422].includes(error.status)
          ) {
            await this.store.update(
              "observations",
              item.key,
              subject,
              (old) => ({ ...old, pending: false, rejected: true }),
            );
            this.patch({
              gap: "有网页观察被服务端拒绝；未据此确认已读或声音状态",
            });
            continue;
          }
          this.patch({ status: "网页观察待同步，服务端通知继续接收" });
          break;
        }
        if (!this.current(generation)) return;
        await this.store.update("observations", item.key, subject, (old) => ({
          ...old,
          pending: false,
        }));
      }
      if (performance.now() > this.nextHealth) {
        const health = await api(base + "/health");
        if (!this.current(generation)) return;
        this.nextHealth = performance.now() + 30000;
        this.soundAllowed = health.sound_enabled === true;
        this.displayEnabled = health.display_enabled === true;
        if (!this.displayEnabled) {
          this.queue = [];
          this.patch({ bubble: null });
        }
        const stale = !health.at || Date.now() - health.at > 90000;
        this.patch({
          status: !health.display_enabled
            ? "通知展示已暂停"
            : stale
              ? "投影 worker 状态未知"
              : health.state === "failed"
                ? "投影受限，来源记录仍保留"
                : "已同步",
        });
      }
      this.errorCount = 0;
      if (performance.now() >= this.nextPrune) {
        const pruned = await this.store.prune(subject);
        this.nextPrune = performance.now() + 60000;
        if (pruned.lost) {
          const gap = `${pruned.lost} 条本机记录超过七天，未能保存到服务器（最早 ${new Date(pruned.from!).toLocaleString()}）`;
          await this.store.update("meta", subject + ":gap", subject, () => gap);
          if (this.current(generation)) this.patch({ gap });
        }
      }
      await this.loadPending(generation);
      void this.playCandidates();
      this.schedule(generation, more ? 20 : 2000);
    } catch (error) {
      if (!this.current(generation)) return;
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "NOTICE_RESET"
      ) {
        this.after = "";
        this.epoch = "";
        this.nextHealth = 0;
        this.queue = [];
        this.candidates.clear();
        this.patch({
          epoch: "",
          events: [],
          bubble: null,
          status: "通知日志已换代，正在恢复；历史不会重新提示或响铃",
        });
        this.schedule(generation, 0);
      } else if (error instanceof ApiError && error.status === 401) {
        this.pause();
      } else {
        this.patch({ status: "连接受限，本机待同步记录保留" });
        this.schedule(
          generation,
          Math.min(60000, 1000 * 2 ** Math.min(6, ++this.errorCount)) *
            (0.8 + Math.random() * 0.4),
        );
      }
    } finally {
      if (this.current(generation)) this.working = false;
    }
  }
  async setEnabled(enabled: boolean) {
    const generation = this.generation,
      subject = this.subject;
    if (!this.ready) return;
    // Start resume in the activation task, before asynchronous persistence.
    const unlock = enabled ? this.unlock() : Promise.resolve();
    await this.store.update("meta", subject + ":sound", subject, () => enabled);
    if (!this.current(generation)) return;
    this.patch({
      enabled,
      soundStatus: enabled ? "等待音频解锁" : "网页声音未启用",
    });
    this.channel?.postMessage({ subject, type: "sound", enabled });
    await unlock;
    void this.playCandidates();
  }
  async unlock() {
    const generation = this.generation;
    this.audio ??= new AudioContext();
    await Promise.race([this.audio.resume(), delay(350)]);
    if (!this.current(generation)) return;
    const unlocked = this.audio.state === "running";
    this.patch({
      unlocked,
      soundStatus: unlocked
        ? "音频已解锁"
        : "浏览器阻止音频，请在父页面手动解锁",
    });
    if (unlocked) void this.playCandidates();
  }
  private tone() {
    const audio = this.audio!;
    if (audio.state !== "running") throw Error("AudioContext 未运行");
    const oscillator = audio.createOscillator(),
      gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);
    gain.gain.value = 0.12;
    oscillator.frequency.value = 660;
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.5);
  }
  async preview() {
    await this.unlock();
    if (!this.state.unlocked) throw Error("浏览器未允许音频，请手动解锁");
    this.tone();
  }
  private async playCandidates() {
    const generation = this.generation;
    try {
      await this.playCandidatesWithClaims();
    } catch (error) {
      if (this.current(generation))
        this.patch({
          soundLimited: true,
          gap: "声音协调记录无法持久保存，自动声音已受限：" + String(error),
        });
    }
  }
  private async playCandidatesWithClaims() {
    const generation = this.generation,
      subject = this.subject;
    if (!this.ready || !subject) return;
    for (const [id, event] of this.candidates) {
      if (!this.current(generation)) return;
      const age = this.estimateNow() - (event.accepted_at ?? event.occurred_at);
      if (age > 30000) {
        await this.observation(id, "sound_expired", {
          reason: "超过30秒实时窗口",
        });
        this.candidates.delete(id);
        continue;
      }
      if (!this.state.enabled || !this.soundAllowed) {
        await this.observation(id, "sound_suppressed", {
          reason: "网页声音或服务端声音开关未启用",
        });
        this.candidates.delete(id);
        continue;
      }
      if (!navigator.locks || this.state.soundLimited) {
        this.patch({ soundLimited: true });
        await this.observation(id, "sound_blocked", {
          reason: "缺少可靠的跨标签页播放协调",
        });
        continue;
      }
      if (!this.state.unlocked || document.visibilityState !== "visible") {
        await this.observation(id, "sound_blocked", {
          reason: "页面隐藏或尚未手势解锁",
        });
        continue;
      }
      await navigator.locks.request(
        "mw-chart-notice-sound:" + subject + ":" + this.profile,
        async () => {
          if (
            !this.current(generation) ||
            !this.state.enabled ||
            !this.state.unlocked ||
            document.visibilityState !== "visible" ||
            this.estimateNow() - (event.accepted_at ?? event.occurred_at) >
              30000
          )
            return;
          const key = subject + ":sound:" + this.profile + ":" + id;
          const previous = await this.store.update(
            "claims",
            key,
            subject,
            (old) => (old ? undefined : { state: "reserved" }),
          );
          if (previous) {
            this.candidates.delete(id);
            return;
          }
          if (!this.current(generation)) return;
          await this.observation(id, "sound_reserved", {
            reason: "自动播放已持久预留，不自动重试",
          });
          if (!this.current(generation)) return;
          try {
            this.tone();
            await this.store.update("claims", key, subject, () => ({
              state: "started",
            }));
            if (this.current(generation))
              await this.observation(id, "sound_started", {
                reason: "AudioContext 已开始；不代表用户听见",
              });
          } catch (error) {
            await this.store.update("claims", key, subject, () => ({
              state: "failed",
            }));
            if (this.current(generation))
              await this.observation(id, "sound_failed", {
                reason: scrub(String(error)),
              });
          }
          this.candidates.delete(id);
        },
      );
    }
  }
  async action(action: NoticeAction) {
    const generation = this.generation;
    if (!this.ready) throw Error("通知模块尚未持久初始化");
    const id = action.event_id;
    let result: any;
    if (action.action === "history") {
      const query = new URLSearchParams(action.filters || {});
      query.set("audience", "system");
      if (action.before) query.set("before", action.before);
      result = await api(base + "/events?" + query);
    } else if (
      action.action === "read-system" &&
      action.through !== undefined &&
      action.epoch
    ) {
      let more = true,
        batches = 0;
      while (more && batches++ < 100) {
        result = await api(base + "/system/read", {
          profile: this.profile,
          through: action.through,
          epoch: action.epoch,
          incident_id: action.incident_id || null,
        });
        if (!this.current(generation)) throw Error("通知会话已失效");
        more = result.more;
      }
      this.patch({
        unread: result.system_unread,
        revision: this.state.revision + 1,
      });
      this.schedule(generation, 0);
      if (more) throw Error("部分系统消息已读，请再次执行以继续处理剩余记录");
    } else if (action.action === "system-popups") {
      await this.store.update(
        "meta",
        this.subject + ":system-popups",
        this.subject,
        () => action.enabled !== false,
      );
      if (!this.current(generation)) throw Error("通知会话已失效");
      this.applySystemPopups(action.enabled !== false);
      this.channel?.postMessage({
        type: "system-popups",
        subject: this.subject,
        enabled: this.state.systemPopups,
      });
      result = { ok: true };
    } else if (action.action === "resolve-alert" && id) {
      result = await api(base + "/resolve?signal=" + encodeURIComponent(id));
    } else if (action.action === "detail" && id) {
      result = await api(base + "/events/" + encodeURIComponent(id));
    } else if (action.action === "timeline" && id) {
      result = await api(
        base +
          "/events/" +
          encodeURIComponent(id) +
          "/timeline" +
          (action.before ? "?before=" + encodeURIComponent(action.before) : ""),
      );
    } else if (
      action.action === "observe" &&
      id &&
      ["viewed", "handled"].includes(action.kind || "")
    ) {
      await this.observation(id, action.kind!, {}, true);
      result = { ok: true };
    } else if (action.action === "rendered" && id) {
      await this.rendered(id);
      result = { ok: true };
    } else if (action.action === "stop" && id) {
      const detail = await api<Notice>(
        base + "/events/" + encodeURIComponent(id),
      );
      if (!this.current(generation)) throw Error("会话已切换");
      if (!detail.notification_id) throw Error("此通知没有可停止的手机提醒");
      result = await api(
        "/notifications/" + encodeURIComponent(detail.notification_id) + "/ack",
        {},
      );
      this.schedule(generation, 0);
    } else if (action.action === "sound") {
      await this.setEnabled(action.enabled === true);
      result = { ok: true };
    } else if (action.action === "unlock") {
      await this.unlock();
      result = { ok: true };
    } else if (action.action === "dismiss") {
      this.dismiss();
      result = { ok: true };
    } else throw Error("不允许的通知操作");
    if (!this.current(generation)) throw Error("通知会话已失效，忽略过期响应");
    return result;
  }
  private applySystemPopups(enabled: boolean) {
    if (!enabled)
      this.queue = this.queue.filter(
        (row) => row.source_kind === "chart_alert",
      );
    const dismiss =
      !enabled &&
      this.state.bubble &&
      this.state.bubble.source_kind !== "chart_alert";
    this.patch({ systemPopups: enabled });
    if (dismiss) this.dismiss();
  }
}
