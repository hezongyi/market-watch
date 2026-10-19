export const systemPopupDurations = [3, 5, 8, 10, 15, 30] as const;
export const defaultSystemPopupSeconds = 3;
export function systemPopupSeconds(value: unknown): number {
  return typeof value === "number" &&
    (systemPopupDurations as readonly number[]).includes(value)
    ? value
    : defaultSystemPopupSeconds;
}
