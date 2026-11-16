import { sourceLabel } from "./marketIdentity";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import type { CatalogItem } from "../market-data/CreationCatalog";
import type { Continuation } from "../market-data/DatasetContinuation";
import type { Dataset } from "../market-data/types";
import {
  matchFields,
  matchKey,
  pair,
  type MatchCheck,
  type ProductMatch,
  type SavedMapping,
} from "../market-data/mapping";
import type { Profile } from "./cache";
import MobileSheet from "./MobileSheet";
import { managedCode } from "./dataMarkets";
import { Button } from "./components/ui/button";
import { FieldGroup } from "./components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { DataFeedback, DataInput, DataMore, DataSelect } from "./DataFormParts";
import { DataLoading } from "./DataStates";
import {
  dataRequest,
  sourceName,
  useDataCommand,
  useDataRead,
} from "./dataOperations";

export default function DataContinuationSheet({
  dataset,
  profile,
  online,
  active,
  open,
  close,
  changed,
  onClosed,
}: {
  dataset: Dataset;
  profile: Profile;
  online: boolean;
  active: boolean;
  open: boolean;
  close(): void;
  changed(): void;
  onClosed(): void;
}) {
  const base = `/market-data/datasets/${dataset.id}`;
  const current = useDataRead<Continuation>(
    profile,
    base + "/continuation",
    active,
    online,
  );
  const hint = pair(dataset.identity.provider_symbol, dataset.asset_class);
  const [query, setQuery] = useState(
    hint
      ? `${hint.underlying}_${hint.quote_currency}`
      : dataset.identity.provider_symbol,
  );
  const catalog = useDataRead<{
    items: CatalogItem[];
    sources: { connection_configured: boolean; requires_refresh: boolean }[];
  }>(
    profile,
    "/market-data/history-catalog/search?" +
      new URLSearchParams({ source: "oanda", query, limit: "100" }),
    active,
    online,
  );
  const [catalogId, setCatalogId] = useState(""),
    [mappingId, setMappingId] = useState("");
  const [newMapping, setNewMapping] = useState(false);
  const [match, setMatch] = useState<ProductMatch>(),
    [check, setCheck] = useState<{ key: string; result: MatchCheck }>();
  const [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState("");
  const [dirty, setDirty] = useState(false),
    [epoch, setEpoch] = useState(0);
  const [savedId, setSavedId] = useState(""),
    [unknown, setUnknown] = useState(false);
  const uncertain = useRef<
    | {
        catalog_id: string;
        match: ProductMatch;
        provider_symbol: string;
        snapshot: MatchCheck["snapshot"];
      }
    | undefined
  >(undefined);
  const command = useDataCommand(profile, online);
  const row = current.data,
    valid =
      row?.mappings.filter((m) => m.current_account && m.valid_for_selection) ||
      [];
  const selected = catalog.data?.items.find(
    (item) => item.catalog_id === catalogId,
  );
  const signature = catalogId + ":" + (match ? matchKey(match) : "hydrate");
  const checked = check?.key === signature ? check.result : undefined;
  const creating = !valid.length || newMapping;
  useEffect(() => {
    if (!row || mappingId || savedId) return;
    if (
      row.default_mapping_id &&
      valid.some((item) => item.id === row.default_mapping_id)
    )
      setMappingId(row.default_mapping_id);
  }, [row?.default_mapping_id]);
  useEffect(() => {
    if (!row || catalogId || catalog.data?.items.length !== 1 || valid.length)
      return;
    setCatalogId(catalog.data.items[0].catalog_id);
  }, [catalog.data, row?.default_mapping_id, catalogId]);
  useEffect(() => {
    if (!catalogId || mappingId || !online || !active) return;
    const controller = new AbortController();
    setChecking(true);
    setCheckError("");
    void dataRequest<MatchCheck>(
      profile,
      base + "/mapping-check",
      { catalog_id: catalogId, match: match ? matchFields(match) : null },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!match) setMatch(result.suggestion);
        else setCheck({ key: signature, result });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCheckError(String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [signature, mappingId, online, active, epoch]);
  function choose(id: string) {
    setCatalogId(id);
    setMatch(undefined);
    setCheck(undefined);
    setSavedId("");
    setDirty(true);
  }
  async function enable() {
    await command.run(async (request) => {
      let ident = savedId || mappingId;
      if (unknown && uncertain.current) {
        const all = await request<{ items: SavedMapping[] }>(
          profile,
          base + "/mappings",
        );
        const submission = uncertain.current;
        const found = all.items.find(
          (item) =>
            item.current_account &&
            item.valid_for_selection &&
            item.target_identity.account_scope ===
              submission.snapshot.account_scope &&
            item.target_identity.provider_symbol ===
              submission.provider_symbol &&
            matchKey({
              ...matchFields(item.match),
              ...item.note,
              reviewed: submission.match.reviewed,
            }) === matchKey(submission.match),
        );
        if (!found) {
          setUnknown(false);
          throw Error("尚未找到已保存配置，可用原配置重试");
        }
        ident = found.id;
        setSavedId(ident);
        setUnknown(false);
      }
      if (!ident) {
        if (!checked || checked.status !== "ready" || !match || !selected)
          throw Error("请先完成来源核对");
        const submission = {
          catalog_id: catalogId,
          match: matchFields(match),
          provider_symbol: selected.provider_symbol,
          snapshot: checked.snapshot,
        };
        uncertain.current = submission;
        try {
          const saved = await request<SavedMapping>(
            profile,
            base + "/mappings",
            {
              catalog_id: submission.catalog_id,
              match: submission.match,
              snapshot: submission.snapshot,
            },
          );
          if (
            !saved.current_account ||
            !saved.valid_for_selection ||
            !/^[a-f0-9]{64}$/.test(saved.id)
          )
            throw Error("保存结果不完整，请核查配置");
          ident = saved.id;
          setSavedId(ident);
          setDirty(false);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status >= 500)
            setUnknown(true);
          throw error;
        }
      }
      try {
        await request<Continuation>(profile, base + "/continuation", {
          enabled: true,
          mapping_id: ident,
        });
      } catch (error) {
        const actual = await request<Continuation>(
          profile,
          base + "/continuation",
        );
        if (!actual.enabled || actual.default_mapping_id !== ident)
          throw Error(`配置已保存，实时未开启：${String(error)}`);
      }
      setDirty(false);
      changed();
      close();
    });
  }
  const difference = checked?.difference || check?.result.difference;
  const unsupported = row && !row.supported;
  return (
    <MobileSheet
      title="确认实时来源"
      open={open}
      onClosed={onClosed}
      fullHeight
      dirty={dirty}
      dismissible={!command.busy}
      close={close}
    >
      <div className="data-workflow-form">
        <div className="data-selection">
          <strong>{managedCode(dataset)}</strong>
          <span>{sourceLabel(dataset.source_display) || sourceName(dataset.identity.source)} → OANDA Practice</span>
        </div>
        <DataFeedback
          error={current.error || command.error || checkError}
          notice={
            unsupported ? row.reason || "当前行情暂不支持实时接续" : undefined
          }
        />
        {current.loading && !row && <DataLoading label="正在核对实时来源…" />}
        {!!valid.length && (
          <DataSelect
            label="已保存的实时配置"
            value={newMapping ? "new" : mappingId}
            disabled={command.busy || unknown}
            items={[
              { value: "", label: "请选择实时配置" },
              { value: "new", label: "核对其他实时品种" },
              ...valid.map((item) => ({
                value: item.id,
                label: `${item.target_display_symbol || item.target_identity.provider_symbol} · ${item.id.slice(0, 8)}`,
              })),
            ]}
            onChange={(id) => {
              setNewMapping(id === "new");
              setMappingId(id === "new" ? "" : id);
              setSavedId("");
              setDirty(true);
            }}
          />
        )}
        {!mappingId && creating && (
          <FieldGroup>
            <DataInput
              label="搜索实时品种"
              type="search"
              value={query}
              disabled={command.busy || unknown}
              onChange={(e) => {
                setQuery(e.target.value);
                choose("");
              }}
            />
            {catalog.loading && !catalog.data && (
              <DataLoading label="正在读取当前账户目录…" rows={2} />
            )}
            <DataSelect
              label="OANDA 准确品种"
              value={catalogId}
              items={[
                { value: "", label: "请选择实时品种" },
                ...(catalog.data?.items || []).map((item) => ({
                  value: item.catalog_id,
                  label: `${item.provider_symbol} · ${item.label}`,
                })),
              ]}
              onChange={choose}
              disabled={command.busy || unknown}
            />
            <DataFeedback error={catalog.error} />
            <p className="data-caption" role="status">
              {checking
                ? "正在核对产品、账户和价格口径…"
                : checked?.status === "ready"
                  ? "来源核对通过"
                  : checked
                    ? Object.values(checked.errors).join("；")
                    : undefined}
            </p>
            {difference && (
              <>
                <DataFeedback notice={difference} />
                <ToggleGroup
                  aria-label="确认产品差异"
                  disabled={command.busy || unknown}
                  value={match?.reviewed ? ["reviewed"] : []}
                  onValueChange={(v) => {
                    setMatch((old) =>
                      old ? { ...old, reviewed: v.includes("reviewed") } : old,
                    );
                    setDirty(true);
                    setSavedId("");
                  }}
                >
                  <ToggleGroupItem value="reviewed">
                    我已确认产品差异，接受 Bid 原价接续
                  </ToggleGroupItem>
                </ToggleGroup>
              </>
            )}
            <DataMore title="匹配详情">
              <p>
                历史：{dataset.identity.provider_symbol} ·{" "}
                {dataset.identity.basis.toUpperCase()}
              </p>
              <p>
                实时：{selected?.provider_symbol || "待选择"} · Bid · 当前
                Practice 账户
              </p>
              <p>{checked?.conclusion}</p>
              {checked?.sources.map((source) => (
                <p key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.scope}
                  </a>
                </p>
              ))}
            </DataMore>
          </FieldGroup>
        )}
        {(!catalog.data?.items.length || unsupported) && (
          <Button
            variant="outline"
            disabled={!online || command.busy}
            onClick={() =>
              void command.run(async (request) => {
                await request(profile, "/market-data/history-catalog/refresh", {
                  source: "oanda",
                });
                catalog.refresh();
                current.refresh();
                setEpoch((n) => n + 1);
              })
            }
          >
            更新实时来源目录
          </Button>
        )}
        {checkError && (
          <Button
            variant="outline"
            disabled={!online || command.busy}
            onClick={() => setEpoch((n) => n + 1)}
          >
            重新核对
          </Button>
        )}
        <Button
          className="data-primary"
          disabled={
            !online ||
            command.busy ||
            !row ||
            !!current.readAt ||
            !!current.error ||
            (!creating && !mappingId && !savedId) ||
            (!!mappingId && !valid.some((item) => item.id === mappingId)) ||
            (!unknown &&
              !savedId &&
              !mappingId &&
              (checking || checked?.status !== "ready")) ||
            !!unsupported
          }
          onClick={() => void enable()}
        >
          {command.busy
            ? "正在处理…"
            : unknown
              ? "核查配置并开启"
              : savedId
                ? "重试开启实时"
                : "确认并开启"}
        </Button>
        <p className="data-caption">
          沿用历史日界和 Bid
          原价。配置保存在服务器，离开本页后实时采集继续。历史定时维护单独控制。
        </p>
      </div>
    </MobileSheet>
  );
}
