import { centerLocation } from "./location";

export type ReturnContext = { location: string; label: string };

/** A window owns a bounded set of internal return positions. URLs carry only
 * opaque keys, so repeated detail/task jumps cannot nest return_to recursively. */
export class ReturnContexts {
  private records = new Map<string, ReturnContext>();
  constructor(readonly workspace: string) {}
  remember(location: string, label: string) {
    const key = crypto.randomUUID();
    this.records.set(key, { location: centerLocation(location), label: label.slice(0, 120) });
    if (this.records.size > 32) this.records.delete(this.records.keys().next().value!);
    return key;
  }
  get(key: string) { return this.records.get(key); }
}
