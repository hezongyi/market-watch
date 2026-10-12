/** Match DataQuery's bounded multi-indicator contract at the frame transport. */
export function validIndicatorRead(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length <= 12 &&
    value.every(spec => spec && typeof spec === "object" && !Array.isArray(spec) &&
      typeof spec.name === "string" && spec.name.length > 0 && spec.name.length <= 80) &&
    JSON.stringify(value).length <= 20000;
}
