import { readSnapshot, writeSnapshot, type Profile } from "./cache";
import { chartSymbolKey } from "./chartIdentity";

export type ChartPreview = {
  symbol: string; resolution: string; theme: string; image: string; at: number;
  layout: string; top: number; bottom: number;
};
export const previewKey = (value: Pick<ChartPreview, "symbol" | "resolution" | "theme">) =>
  JSON.stringify([chartSymbolKey(value.symbol), value.resolution, value.theme]);

/** A small preview album, partitioned by the existing origin/subject store. */
export function chartPreviews(profile: Profile) {
  let rows: ChartPreview[] = [], writes = Promise.resolve(), revision = 0;
  return {
    async load() {
      const version = revision;
      const saved = await readSnapshot<ChartPreview[]>(profile, "chart-previews").catch(() => undefined);
      if (revision === version) rows = Array.isArray(saved?.value) ? saved.value.slice(0, 6) : [];
    },
    find(target: Pick<ChartPreview, "symbol" | "resolution" | "theme">, layout?: string) {
      return rows.find(row => previewKey(row) === previewKey(target) &&
        (layout === undefined || row.layout === layout));
    },
    put(row: ChartPreview) {
      if (!row.image.startsWith("data:image/") || row.image.length > 900_000) return;
      revision++;
      rows = [row, ...rows.filter(old => previewKey(old) !== previewKey(row))].slice(0, 6);
      const next = rows;
      writes = writes.catch(() => {}).then(() => writeSnapshot(profile, "chart-previews", next));
      void writes.catch(() => {});
    },
    clear() {
      revision++; rows = [];
      writes = writes.catch(() => {}).then(() => writeSnapshot(profile, "chart-previews", []));
      void writes.catch(() => {});
    },
  };
}
