import type { AlertApi } from "./chartAlertUiApi";
import { relations, type AlertRow } from "./chartAlerts";

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
      saved.version > row.version &&
      saved.config.condition.right?.kind === "constant" &&
      saved.config.condition.right.value === price
    )
      return saved;
    if (saved && error instanceof Error)
      Object.assign(error, { currentRow: saved });
    throw error;
  }
}
