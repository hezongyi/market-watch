import { LocalStore } from "./localStore";
import type { CenterEvent } from "./types";

export type SoundOutcome =
  | "started"
  | "blocked"
  | "suppressed"
  | "expired"
  | "failed"
  | "unknown"
  | "duplicate";

export type SoundObserver = (kind: string, meta: Record<string, unknown>) => void;

const SOUND_KEY = "mw-notification-sound";

function tone(context: AudioContext) {
  const at = context.currentTime;
  for (const [offset, frequency] of [[0, 880], [0.18, 1174.66]] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at + offset);
    gain.gain.exponentialRampToValueAtTime(0.16, at + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at + offset);
    oscillator.stop(at + offset + 0.18);
  }
}

/**
 * One shared sound consumer per browser profile. Reservation is persisted
 * before playback so an automatic attempt happens at most once per
 * subject/profile/event, even across tabs and reloads.
 */
export class SoundCoordinator {
  enabled = false;
  private context: AudioContext | null = null;
  private channel: BroadcastChannel | null = null;

  constructor(
    private local: LocalStore,
    private profile: string,
    private observe: SoundObserver,
    private serverNow: () => number,
  ) {
    this.enabled = localStorage.getItem(SOUND_KEY) === "1";
    try {
      this.channel = typeof BroadcastChannel === "function"
        ? new BroadcastChannel("mw-notification-sound") : null;
    } catch {
      this.channel = null;
    }
  }

  /** Must be called from a user gesture to unlock audio. */
  async enable(): Promise<boolean> {
    try {
      this.context ??= new AudioContext();
      await this.context.resume();
      if (this.context.state !== "running") return false;
      this.enabled = true;
      localStorage.setItem(SOUND_KEY, "1");
      return true;
    } catch {
      return false;
    }
  }

  disable() {
    this.enabled = false;
    localStorage.setItem(SOUND_KEY, "0");
  }

  private key(event: CenterEvent) {
    return `owner|${this.profile}|${event.id}|web`;
  }

  async attempt(event: CenterEvent): Promise<SoundOutcome> {
    if (!event.notify_web) {
      this.observe("sound_suppressed", { event_id: event.id, reason: "notify_web_false" });
      return "suppressed";
    }
    if (document.visibilityState !== "visible") {
      this.observe("sound_suppressed", { event_id: event.id, reason: "hidden" });
      return "suppressed";
    }
    if (this.serverNow() - event.recorded_at > 30_000) {
      this.observe("sound_expired", { event_id: event.id, age_ms: this.serverNow() - event.recorded_at });
      return "expired";
    }
    if (!this.enabled) {
      this.observe("sound_blocked", { event_id: event.id, reason: "gesture_required" });
      return "blocked";
    }
    const run = async (): Promise<SoundOutcome> => {
      if (await this.local.add("sounds", this.key(event)) === false) {
        this.observe("sound_suppressed", { event_id: event.id, reason: "already_reserved" });
        return "duplicate";
      }
      this.observe("sound_reserved", { event_id: event.id });
      const context = this.context;
      if (!context) {
        this.observe("sound_failed", { event_id: event.id, reason: "audio_unavailable" });
        return "failed";
      }
      try {
        if (context.state === "suspended") await context.resume();
        await context.resume();
        tone(context);
        this.observe("sound_started", { event_id: event.id, state: context.state });
        this.channel?.postMessage({ type: "sound-started", event_id: event.id, at: Date.now() });
        return "started";
      } catch (error) {
        this.observe("sound_failed", { event_id: event.id, reason: String(error) });
        return "failed";
      }
    };
    try {
      const locks = navigator.locks;
      if (locks?.request) return await locks.request("mw-notification-sound", run);
      return await run();
    } catch {
      this.observe("sound_unknown", { event_id: event.id, reason: "lock_failure" });
      return "unknown";
    }
  }
}
