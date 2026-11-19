import type { AlertApi } from "./chartAlertUiApi";
import { relations, type AlertRow } from "./chartAlerts";

function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

export type PricePresentation = { previousText: string; text: string };

/** Price gestures use the existing authenticated edit route and version fence. */
export async function editAlertPrice(
  row: AlertRow,
  price: string,
  request: AlertApi,
  presentation?: PricePresentation,
) {
  if (
    !/^(?:\d+)(?:\.\d+)?$/.test(price) ||
    price.length > 100 ||
    !Number.isFinite(Number(price)) ||
    Number(price) <= 0
  )
    throw Error("告警价格必须大于零");
  const latest = await request<AlertRow>(`/chart-alerts/${row.id}`);
  const c = latest.config.condition;
  if (
    latest.version !== row.version ||
    latest.control_revision !== row.control_revision
  )
    throw Object.assign(
      Error("告警版本或状态已改变，已读取当前价格，请重新拖动"),
      { currentRow: latest },
    );
  if (
    !["active", "paused"].includes(latest.status) ||
    latest.config.association?.object_kind ||
    c.left.kind !== "price" ||
    c.right?.kind !== "constant" ||
    c.offset ||
    !["cross", "cross_up", "cross_down", "above", "below"].includes(c.relation)
  )
    throw Error("此告警不能拖动改价，请通过编辑窗口调整");
  const config = structuredClone(latest.config);
  // A fixed threshold is a series rule; editing it never checkpoints a layout.
  config.association = null;
  const code = latest.display_identity?.code;
  const automatic =
    code &&
    (config.name === `${code} ${relations[c.relation]} ${c.right.value}` ||
      (!!presentation &&
        config.name ===
          `${code} ${relations[c.relation]} ${presentation.previousText}`));
  config.condition.right = { kind: "constant", value: price };
  if (automatic)
    config.name = `${code} ${relations[c.relation]} ${presentation?.text || price}`;
  try {
    return await request<AlertRow>(`/chart-alerts/${row.id}/edit`, {
      version: row.version,
      control_revision: row.control_revision,
      config,
    });
  } catch (error) {
    // A lost response can follow a successful commit. Re-read before reverting.
    let saved: AlertRow | undefined;
    try {
      saved = await request<AlertRow>(`/chart-alerts/${row.id}`);
    } catch {
      /* Last confirmed price remains available. */
    }
    if (
      saved &&
      saved.version === row.version + 1 &&
      canonical(saved.config) === canonical(config)
    )
      return saved;
    if (saved && error instanceof Error)
      Object.assign(error, { currentRow: saved });
    const status = (error as any)?.status;
    const ambiguous = !status || status < 400 || status >= 500 || status === 408;
    // A read of the old revision can race a POST whose response timed out.
    if (ambiguous && error instanceof Error && (!saved ||
        (saved.version <= row.version && saved.control_revision <= row.control_revision)))
      Object.assign(error, {outcomeUnknown: true});
    throw error;
  }
}
