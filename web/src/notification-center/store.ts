import { api, ApiError } from "../api";
import { LocalStore } from "./localStore";
import { SoundCoordinator } from "./sound";
import type { CenterEvent, Change, Detail, Filters, Incident, Page } from "./types";

const PROFILE_KEY = "mw-notification-profile";
const PENDING_LIMIT = 1000;
const PENDING_BYTES = 10 * 1024 * 1024;
const MEMORY_LIMIT = 200;
const BUBBLE_QUEUE_LIMIT = 20;

export type Connection = "connecting" | "live" | "polling" | "offline";

export type CenterState = {
  ready: boolean;
  connection: Connection;
  epoch: string;
  cursor: number;
  highWatermark: number;
  items: CenterEvent[];
  unread: number;
  pending: number;
  storage: "ok" | "unavailable" | "limited";
  notices: string[];
  filters: Filters;
  detail: Detail | null;
  detailLoading: boolean;
  soundEnabled: boolean;
  bubble: { event: CenterEvent; at: number; duration: number; held: boolean } | null;
  nextBefore: string | null;
  loadingMore: boolean;
  olderWindow: boolean;
};

export type ReportInput = {
  kind?: CenterEvent["kind"];
  severity?: CenterEvent["severity"];
  title: string;
  summary?: string;
  occurred_at?: number;
  dedupe_key?: string;
  context?: Record<string, unknown>;
  links?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

const EMPTY_FILTERS: Filters = { kind: "", severity: "", status: "", q: "" };
const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

function uuid(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sortItems(items: CenterEvent[]): CenterEvent[] {
  return [...items].sort((left, right) =>
    right.occurred_at - left.occurred_at || (left.id < right.id ? 1 : -1));
}

function query(filters: Filters, before?: string | null): string {
  const params = new URLSearchParams();
  params.set("limit", "100");
  if (before) params.set("before", before);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.status) params.set("status", filters.status);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  return params.toString();
}

export class NotificationStore {
  private state: CenterState = {
    ready: false,
    connection: "connecting",
    epoch: "",
    cursor: 0,
    highWatermark: 0,
    items: [],
    unread: 0,
    pending: 0,
    storage: "ok",
    notices: [],
    filters: { ...EMPTY_FILTERS },
    detail: null,
    detailLoading: false,
    soundEnabled: false,
    bubble: null,
    nextBefore: null,
    loadingMore: false,
    olderWindow: false,
  };
  private listeners = new Set<() => void>();
  private local = new LocalStore();
  private profile = "";
  private sound: SoundCoordinator | null = null;
  private serverOffset = 0;
  private source: EventSource | null = null;
  private pollTimer: number | undefined;
  private flushTimer: number | undefined;
  private bubbleTimer: number | undefined;
  private queue: CenterEvent[] = [];
  private bubbled = new Set<string>();
  private observedReceipts = new Set<string>();
  private started = false;
  private refreshing = false;
  private flushing = false;
  private cursorSavedAt = 0;

  getSnapshot = (): CenterState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<CenterState>) {
    const next = { ...this.state, ...patch };
    if (patch.items) next.items = patch.items.slice(0, MEMORY_LIMIT);
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private notice(message: string) {
    if (this.state.notices.includes(message)) return;
    this.update({ notices: [...this.state.notices, message].slice(-5) });
  }

  serverNow(): number {
    return Date.now() + this.serverOffset;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.profile = this.profileId();
    this.sound = new SoundCoordinator(
      this.local, this.profile,
      (kind, meta) => { void this.observe(String(meta.event_id || ""), kind, { meta }); },
      () => this.serverNow(),
    );
    this.update({ soundEnabled: this.sound.enabled });
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.calibrate();
    await this.refresh(true);
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.tick();
    }, 20_000);
    void this.flush();
  }

  stop(): void {
    this.started = false;
    this.source?.close();
    this.source = null;
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onOnline = () => {
    this.update({ connection: "connecting" });
    void this.flush();
    void this.tick();
  };

  private onOffline = () => this.update({ connection: "offline" });

  private onVisibility = () => {
    if (document.visibilityState === "visible") {
      void this.flush();
      void this.tick();
    }
  };

  private profileId(): string {
    let value = localStorage.getItem(PROFILE_KEY);
    if (!value) {
      value = uuid();
      localStorage.setItem(PROFILE_KEY, value);
    }
    return value;
  }

  private async calibrate(): Promise<void> {
    try {
      const response = await fetch("/api/notification-center/summary", {
        credentials: "same-origin", cache: "no-store",
      });
      const header = response.headers.get("date");
      if (header) {
        const server = Date.parse(header);
        if (Number.isFinite(server)) this.serverOffset = server - Date.now();
      }
    } catch {
      /* clock estimate is optional; the 30 s window stays conservative */
    }
  }

  async refresh(reset = false): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const page = await api<Page>(`/notification-center/events?${query(this.state.filters)}`);
      this.applyPage(page, reset);
      if (reset) this.connect();
    } catch (error) {
      if (error instanceof TypeError) {
        this.update({ connection: "offline" });
        this.notice("暂时无法连接通知服务，已保留本机记录。");
      } else {
        this.notice(`通知中心读取失败：${String(error)}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private applyPage(page: Page, reset: boolean) {
    const items = sortItems(page.items);
    this.update({
      ready: true,
      epoch: page.epoch,
      cursor: Math.max(reset ? 0 : this.state.cursor, page.high_watermark),
      highWatermark: page.high_watermark,
      items: reset ? items : sortItems([...items, ...this.state.items]).filter(
        (row, index, all) => all.findIndex((other) => other.id === row.id) === index),
      unread: page.unread,
      nextBefore: page.next_before,
    });
    if (reset) {
      this.update({ olderWindow: false });
      this.saveCursor(page.epoch, page.high_watermark);
    }
  }

  /**
   * Stable pagination. Until the bounded in-memory budget is reached the page
   * is appended; afterwards older pages replace the window so continuous
   * reading never grows memory without bound. The latest view is one click away.
   */
  async loadMore(): Promise<void> {
    if (!this.state.nextBefore || this.state.loadingMore) return;
    this.update({ loadingMore: true });
    try {
      const page = await api<Page>(
        `/notification-center/events?${query(this.state.filters, this.state.nextBefore)}`);
      if (this.state.items.length >= MEMORY_LIMIT) {
        this.update({
          items: sortItems(page.items), nextBefore: page.next_before, olderWindow: true,
        });
      } else {
        const merged = new Map(this.state.items.map((row) => [row.id, row]));
        page.items.forEach((row) => merged.set(row.id, row));
        const sorted = sortItems([...merged.values()]);
        this.update({
          items: sorted,
          nextBefore: page.next_before,
          olderWindow: sorted.length > MEMORY_LIMIT,
        });
      }
    } catch (error) {
      this.notice(`加载更多失败：${String(error)}`);
    } finally {
      this.update({ loadingMore: false });
    }
  }

  async setFilters(filters: Filters): Promise<void> {
    this.update({ filters: { ...filters } });
    await this.refresh(true);
  }

  private connect() {
    this.source?.close();
    const epoch = encodeURIComponent(this.state.epoch);
    const source = new EventSource(
      `/api/notification-center/stream?after_seq=${this.state.cursor}&epoch=${epoch}`);
    this.source = source;
    source.onopen = () => this.update({ connection: "live" });
    source.onerror = () => {
      if (this.state.connection !== "offline") this.update({ connection: "polling" });
    };
    source.addEventListener("change", (message) => {
      try {
        this.applyChange(JSON.parse((message as MessageEvent).data) as Change, true);
      } catch {
        /* malformed frame: the next poll repairs the view */
      }
    });
    source.addEventListener("reset", () => {
      this.notice("通知历史已换代，正在重建本地视图。");
      void this.refresh(true);
    });
  }

  private async tick() {
    if (navigator.onLine === false) {
      this.update({ connection: "offline" });
      return;
    }
    if (this.state.connection === "live") return;
    try {
      const batch = await api<{
        reset: boolean; epoch: string; seq: number; items: Change[];
      }>(`/notification-center/changes?after_seq=${this.state.cursor}&epoch=${encodeURIComponent(this.state.epoch)}`);
      if (batch.reset) {
        this.notice("通知游标已失效，正在重建本地视图。");
        await this.refresh(true);
        return;
      }
      batch.items.forEach((change) => this.applyChange(change, true));
      this.update({ connection: "polling" });
    } catch (error) {
      if (error instanceof TypeError) this.update({ connection: "offline" });
    }
  }

  private applyChange(change: Change, live: boolean) {
    if (!change || typeof change.seq !== "number") return;
    const items = [...this.state.items];
    const index = change.event ? items.findIndex((row) => row.id === change.event!.id) : -1;
    let unread = this.state.unread;
    if (change.type === "created" && change.event) {
      const event = { ...change.event, read: false, incident: change.incident ?? null };
      if (index === -1) items.unshift(event);
      if (live) this.announce(event);
    } else if (change.type === "updated" && change.event && index >= 0) {
      items[index] = { ...items[index], ...change.event, read: items[index].read };
    } else if (change.type === "deleted" && change.event) {
      const at = items.findIndex((row) => row.id === change.event!.id);
      if (at >= 0) items.splice(at, 1);
    } else if (change.type === "incident" && change.incident) {
      const incident = change.incident;
      items.forEach((row, at) => {
        if (row.incident_id === incident.id) {
          items[at] = { ...row, incident: { ...(row.incident ?? incident), ...incident } };
        }
      });
    } else if (change.type === "observation" && change.observation) {
      const observation = change.observation;
      if (observation.kind === "viewed") {
        const at = items.findIndex((row) => row.id === observation.event_id);
        if (at >= 0 && !items[at].read) {
          items[at] = { ...items[at], read: true };
          unread = Math.max(0, unread - 1);
        }
      }
    }
    if (change.seq > this.state.cursor) {
      this.update({ cursor: change.seq, items: sortItems(items), unread });
      this.saveCursor(change.epoch, change.seq);
    } else {
      this.update({ items: sortItems(items), unread });
    }
    if (this.state.detail && change.event?.id === this.state.detail.event.id
        && change.type === "updated") {
      this.update({ detail: { ...this.state.detail, event: change.event } });
    }
  }

  private saveCursor(epoch: string, seq: number) {
    const now = Date.now();
    if (now - this.cursorSavedAt < 2000) return;
    this.cursorSavedAt = now;
    void this.local.put("state", "cursor", { epoch, seq });
  }

  private announce(event: CenterEvent) {
    if (!event.notify_web) return;
    if (this.bubbled.has(event.id)) return;
    this.bubbled.add(event.id);
    if (event.kind !== "success" && SEVERITY_RANK[event.severity] >= 2) {
      void this.sound?.attempt(event);
    }
    this.enqueueBubble(event);
  }

  private enqueueBubble(event: CenterEvent) {
    this.queue = [...this.queue, event]
      .sort((left, right) => (SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity])
        || (left.occurred_at - right.occurred_at))
      .slice(0, BUBBLE_QUEUE_LIMIT);
    this.showNextBubble();
  }

  private showNextBubble() {
    if (this.state.bubble || this.queue.length === 0) return;
    const [event, ...rest] = this.queue;
    this.queue = rest;
    const duration = event.kind === "success" ? 3000 : 8000;
    this.update({ bubble: { event, at: Date.now(), duration, held: false } });
    this.bubbleTimer = window.setTimeout(() => this.dismissBubble(), duration);
  }

  dismissBubble() {
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = undefined;
    this.update({ bubble: null });
    window.setTimeout(() => this.showNextBubble(), 250);
  }

  holdBubble(held: boolean) {
    const bubble = this.state.bubble;
    if (!bubble) return;
    if (held) {
      if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
      this.bubbleTimer = undefined;
      this.update({ bubble: { ...bubble, held: true } });
    } else {
      this.update({ bubble: { ...bubble, held: false } });
      this.bubbleTimer = window.setTimeout(() => this.dismissBubble(), bubble.duration);
    }
  }

  async openDetail(id: string): Promise<void> {
    this.update({ detailLoading: true });
    try {
      const detail = await api<Detail>(`/notification-center/events/${encodeURIComponent(id)}`);
      this.update({ detail, detailLoading: false });
      await this.markViewed(id);
      await this.observe(id, "rendered");
    } catch (error) {
      this.update({ detailLoading: false });
      this.notice(`通知详情读取失败：${String(error)}`);
    }
  }

  closeDetail() {
    this.update({ detail: null });
  }

  async markViewed(id: string): Promise<void> {
    const item = this.state.items.find((row) => row.id === id);
    if (!item || item.read) return;
    this.update({
      items: this.state.items.map((row) => (row.id === id ? { ...row, read: true } : row)),
      unread: Math.max(0, this.state.unread - 1),
      detail: this.state.detail && this.state.detail.event.id === id
        ? { ...this.state.detail, event: { ...this.state.detail.event, read: true } } : this.state.detail,
    });
    await this.observe(id, "viewed");
  }

  async markHandled(id: string): Promise<void> {
    const observation = await this.observe(id, "handled");
    if (observation) {
      this.update({
        items: this.state.items.map((row) =>
          row.id === id ? { ...row, actions: { ...row.actions, handled: true } } : row),
      });
    }
  }

  async stopPhone(id: string): Promise<boolean> {
    const observation = await this.observe(id, "phone_stop");
    return observation !== null;
  }

  /** Automatic observations are deduplicated per event in this browser session. */
  async observeOnce(id: string, kind: "received" | "rendered"): Promise<void> {
    const key = `${id}:${kind}`;
    if (this.observedReceipts.has(key)) return;
    this.observedReceipts.add(key);
    await this.observe(id, kind);
  }

  private async observe(id: string, kind: string, extra: Record<string, unknown> = {}) {
    if (!id) return null;
    try {
      const response = await api<{ observation: any; created: boolean }>(
        "/notification-center/observations",
        { event_id: id, kind, profile_id: this.profile, client_at: Date.now(), ...extra });
      return response.observation;
    } catch {
      return null; // observation is evidence, never a reason to break the UI
    }
  }

  async setSoundEnabled(enabled: boolean): Promise<boolean> {
    if (!this.sound) return false;
    if (enabled) {
      const ok = await this.sound.enable();
      this.update({ soundEnabled: ok });
      if (!ok) this.notice("浏览器未允许播放声音，网页声音仍为关闭。");
      return ok;
    }
    this.sound.disable();
    this.update({ soundEnabled: false });
    return true;
  }

  /**
   * Record a client-side fault. It is shown immediately, persisted locally and
   * uploaded idempotently; an offline client keeps the same event id.
   */
  async report(input: ReportInput): Promise<CenterEvent> {
    const id = `web:${uuid()}`;
    const now = this.serverNow();
    const payload = {
      id,
      kind: input.kind ?? "failure",
      severity: input.severity ?? "warning",
      title: input.title.slice(0, 300),
      summary: (input.summary ?? "").slice(0, 2000),
      occurred_at: input.occurred_at ?? now,
      dedupe_key: input.dedupe_key,
      context: { ...(input.context ?? {}), profile_id: this.profile },
      links: input.links ?? {},
      evidence: input.evidence ?? {},
      profile_id: this.profile,
      notify_web: true,
    };
    const optimistic: CenterEvent = {
      schema_version: 1, id, epoch: this.state.epoch,
      source: { kind: "browser", id, version: "1" },
      kind: payload.kind as CenterEvent["kind"],
      severity: payload.severity as CenterEvent["severity"],
      title: payload.title, summary: payload.summary,
      context: payload.context, links: payload.links,
      actions: { view: true, handled: true, phone_stop: false },
      evidence: payload.evidence, dedupe_key: payload.dedupe_key ?? "",
      incident_id: null, notification_id: null, notify_web: true,
      occurred_at: payload.occurred_at, recorded_at: now,
      first_seq: 0, version: 1, deleted_at: null, read: false, incident: null,
    };
    this.update({ items: sortItems([optimistic, ...this.state.items]) });
    this.announce(optimistic);
    const stored = await this.local.put("pending", id, { payload, attempts: 0, nextAt: 0 });
    if (!stored) {
      this.notice("本机存储不可用，这条通知只在当前页面可见。");
      return optimistic;
    }
    const pending = (await this.local.all<unknown>("pending")).length;
    this.update({ pending, storage: this.local.state });
    if (pending >= PENDING_LIMIT) {
      this.notice(`本机待同步已达 ${PENDING_LIMIT} 条上限，超出的通知不会补传。`);
    }
    void this.flush();
    return optimistic;
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    let pending = 0;
    try {
      const rows = await this.local.all<{
        payload: Record<string, unknown> & { id: string };
        attempts: number; nextAt: number;
      }>("pending");
      let bytes = 0;
      for (const row of rows) {
        bytes += JSON.stringify(row.payload).length;
        if (bytes > PENDING_BYTES) {
          this.notice("本机待同步超过 10 MiB，较早的通知不会补传。");
          break;
        }
        if (row.nextAt > Date.now()) { pending += 1; continue; }
        try {
          await api("/notification-center/events", row.payload);
          await this.local.delete("pending", row.payload.id);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            await this.local.delete("pending", row.payload.id);
            this.notice("一条本机通知与服务端记录冲突，已保留服务端版本。");
          } else if (error instanceof ApiError && error.status === 429) {
            row.nextAt = Date.now() + 60_000;
            await this.local.put("pending", row.payload.id, row);
            pending += 1;
          } else if (error instanceof TypeError) {
            row.attempts += 1;
            row.nextAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
            await this.local.put("pending", row.payload.id, row);
            pending += 1;
          } else {
            await this.local.delete("pending", row.payload.id);
            this.notice(`一条本机通知被服务端拒绝：${String(error)}`);
          }
        }
      }
    } finally {
      this.flushing = false;
      this.update({ pending, storage: this.local.state });
      if (pending > 0 && !this.flushTimer) {
        this.flushTimer = window.setTimeout(() => {
          this.flushTimer = undefined;
          void this.flush();
        }, 5000);
      }
    }
  }

  /** Debug/acceptance hook: same CSRF-aware observation path as the UI. */
  async observeForDebug(id: string, kind: string, extra: Record<string, unknown> = {}) {
    return this.observe(id, kind, extra);
  }

  /** Test/debug surface: bounded, credential-free. */
  debug() {
    return {
      state: this.state,
      profile: this.profile,
      flush: () => this.flush(),
      report: (input: ReportInput) => this.report(input),
    };
  }
}
