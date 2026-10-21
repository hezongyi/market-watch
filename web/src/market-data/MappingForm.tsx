import { useEffect, useRef, useState, type ReactNode } from "react";
import { Feedback } from "./Center";
import { api } from "./api";
import {
  NativeButton,
  NativeInput,
  NativeSelect,
  NativeTextarea,
} from "./NativeControls";
import { NativeCatalogPicker } from "./NativeCatalogPicker";
import { centerReturn } from "./navigation";
import {
  useActionLock,
  useCenter,
  useDirtyForm,
  useMounted,
  useNavigate,
  useParams,
  useSearchParams,
} from "./router";
import { useSnapshot } from "./useSnapshot";
import { names, phase, type Dataset, type Page } from "./types";
import {
  initialMatch,
  matchFields,
  matchKey,
  pair,
  products,
  validMatch,
  type CatalogEntry,
  type ProductMatch,
  type SavedMapping,
} from "./mapping";
import "./mapping.css";

type CatalogPage = Page<CatalogEntry> & { requires_refresh?: boolean };
type Submission = {
  catalog_id: string;
  match: ProductMatch;
  provider_symbol: string;
};

export function MappingForm() {
  const { id } = useParams();
  const dataset = useSnapshot<Dataset>(`/market-data/center/datasets/${id}`);
  const mappings = useSnapshot<{ items: SavedMapping[] }>(
    `/market-data/datasets/${id}/mappings`,
  );
  if (!dataset.data || !mappings.data)
    return (
      <section className="data-center">
        <h1>配置实时来源</h1>
        <Feedback
          error={dataset.error || mappings.error}
          loading={dataset.loading || mappings.loading}
          empty
        />
      </section>
    );
  return (
    <MappingEditor
      key={id}
      dataset={dataset.data}
      mappings={mappings.data.items}
      readError={dataset.error || mappings.error}
    />
  );
}

function MappingEditor({
  dataset,
  mappings,
  readError,
}: {
  dataset: Dataset;
  mappings: SavedMapping[];
  readError: string;
}) {
  const current = mappings.filter((row) => row.current_account);
  const initial = useRef(current.length === 1 ? current[0] : null).current;
  const [mappingId, setMappingId] = useState(initial?.id || "");
  const [match, setMatch] = useState<ProductMatch>(() =>
    initial
      ? { ...matchFields(initial.match), reviewed: false }
      : initialMatch(dataset),
  );
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [expanded, setExpanded] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<ReturnType<typeof validMatch>>(
    {},
  );
  const [directoryRefresh, setDirectoryRefresh] = useState(0),
    [savedEpoch, setSavedEpoch] = useState(0);
  const [checking, setChecking] = useState(!!initial),
    [selectionError, setSelectionError] = useState("");
  const [uncertain, setUncertain] = useState<Submission | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const { apply, clearDirty, busy: centerBusy } = useCenter(),
    navigate = useNavigate(),
    [params] = useSearchParams();
  const mounted = useMounted(),
    lock = useActionLock(),
    errorRef = useRef<HTMLParagraphElement>(null);
  const generation = useRef(0),
    initialized = useRef(false);
  const saved = useRef<{ signature: string; mapping: SavedMapping } | null>(
    null,
  );
  const uncertainOpen = useRef(false);
  const catalog = useSnapshot<CatalogPage>(
    "/market-data/history-catalog?source=oanda&page_size=1",
    directoryRefresh,
  );
  const catalogReady =
    !!catalog.data && !catalog.data.requires_refresh && !catalog.error;
  const back = centerReturn(
    params,
    "/market-data?tab=composite&view=candidates",
  );
  const frozen = busy || centerBusy || !!uncertain;
  const draft = { catalog_id: selected?.catalog_id || "", match };
  useDirtyForm("mapping", draft, savedEpoch);
  useEffect(() => {
    if (
      !mappingId ||
      !mappings.some((row) => row.id === mappingId && !row.current_account)
    )
      return;
    ++generation.current;
    saved.current = null;
    setSelected(null);
    setMappingId("");
    setChecking(false);
    setMatch((old) => ({ ...old, reviewed: false }));
    setSelectionError("实时账户已变化，请为当前账户重新选择品种并核对。");
  }, [mappings, mappingId]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function edit<K extends keyof ProductMatch>(key: K, value: ProductMatch[K]) {
    setMatch((old) => ({
      ...old,
      [key]: value,
      ...(key !== "reviewed" ? { reviewed: false } : {}),
    }));
    setFieldErrors((old) => ({ ...old, [key]: undefined }));
    setError("");
    setNotice("");
    setOpenFailed(false);
  }
  async function checkSelection(code: string, restore = false) {
    const token = ++generation.current;
    setChecking(true);
    setSelectionError("");
    try {
      const result = await api<CatalogPage>(
        `/market-data/history-catalog?source=oanda&query=${encodeURIComponent(code)}&page_size=100`,
      );
      if (!mounted.current || generation.current !== token) return;
      const entry = result.items.find((row) => row.provider_symbol === code);
      if (!entry)
        throw Error("原品种已不在当前账户目录中，请重新读取目录并选择。");
      setSelected(entry);
      if (restore) setSavedEpoch((v) => v + 1);
    } catch (e) {
      if (mounted.current && generation.current === token) {
        setSelected(null);
        setSelectionError(String(e));
      }
    } finally {
      if (mounted.current && generation.current === token) setChecking(false);
    }
  }
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      if (initial)
        void checkSelection(initial.target_identity.provider_symbol, true);
    }
    // Initial saved configuration is hydrated once; polling must never replace a draft.
  }, []);
  function pick(entry: CatalogEntry) {
    setFieldErrors({});
    ++generation.current;
    setChecking(false);
    setSelectionError("");
    setSelected(entry);
    setMappingId("");
    const product =
      (
        {
          forex: "spot_fx",
          metal: "spot_metal",
          crypto: "crypto",
          index: "index",
          future: "future",
        } as Record<string, string>
      )[entry.asset_class] || "other";
    setMatch((old) => ({
      ...old,
      live_product: product,
      relationship: "",
      live_evidence: "",
      rationale: "",
      reviewed: false,
    }));
    setNotice("");
    setError("");
    setOpenFailed(false);
    saved.current = null;
  }
  function restore(id: string) {
    setFieldErrors({});
    const row = current.find((item) => item.id === id);
    ++generation.current;
    setSelected(null);
    setMappingId(id);
    setNotice("");
    setError("");
    setOpenFailed(false);
    saved.current = null;
    setMatch(
      row
        ? { ...matchFields(row.match), reviewed: false }
        : initialMatch(dataset),
    );
    if (row) void checkSelection(row.target_identity.provider_symbol);
    else {
      setChecking(false);
      setSelectionError("");
    }
  }
  async function refreshDirectory() {
    if (!lock.acquire()) return;
    setBusy(true);
    setError("");
    setMatch((old) => ({ ...old, reviewed: false }));
    saved.current = null;
    setOpenFailed(false);
    try {
      await api("/market-data/history-catalog/refresh", {});
      if (!mounted.current) return;
      setDirectoryRefresh((v) => v + 1);
      if (selected) await checkSelection(selected.provider_symbol);
      if (mounted.current) setNotice("品种目录已更新，请重新核对来源。");
    } catch (e) {
      if (mounted.current) setError(`品种目录读取失败：${String(e)}`);
    } finally {
      lock.release();
      if (mounted.current) setBusy(false);
    }
  }
  const sourcePair = pair(
    dataset.identity.provider_symbol,
    dataset.asset_class,
  );
  const targetPair =
    selected && pair(selected.provider_symbol, selected.asset_class);
  const mismatch =
    !!selected &&
    ((["forex", "metal", "crypto", "index"].includes(dataset.asset_class) &&
      selected.asset_class !== dataset.asset_class) ||
      (sourcePair &&
        (!targetPair ||
          sourcePair.underlying !== targetPair.underlying ||
          sourcePair.quote_currency !== targetPair.quote_currency)));
  const available =
    !!selected && catalogReady && !checking && !selectionError && !mismatch;
  function signature(submission: Submission) {
    return submission.catalog_id + ":" + matchKey(submission.match);
  }
  function accepted(mapping: SavedMapping, submission: Submission) {
    saved.current = { signature: signature(submission), mapping };
    setMappingId(mapping.id);
    setUncertain(null);
    setSavedEpoch((v) => v + 1);
    clearDirty();
  }
  async function open(mapping: SavedMapping) {
    if (!mounted.current) return;
    setNotice("配置已保存，正在打开组合行情…");
    try {
      const clientKey = "market-watch-composite-chart-client";
      let client = sessionStorage.getItem(clientKey);
      if (!client) {
        client = `mc-${crypto.randomUUID()}`;
        sessionStorage.setItem(clientKey, client);
      }
      if (uncertainOpen.current) {
        // A timed-out use may already have created the fixed composite. Read
        // its state before repeating the idempotent use/lease command.
        await api(
          `/market-data/center/composites?dataset_id=${dataset.id}&page_size=100`,
        );
        if (!mounted.current) return;
      }
      uncertainOpen.current = true;
      const row = await api<{ id: string }>("/market-data/composites/use", {
        dataset_id: dataset.id,
        mapping_id: mapping.id,
        client,
      });
      if (!mounted.current) return;
      if (!/^[a-f0-9]{64}$/.test(row.id))
        throw Error("打开结果不完整，请核查后重试");
      uncertainOpen.current = false;
      await apply(`MWC:${row.id}`, "M1");
    } catch (e) {
      if (mounted.current) {
        setOpenFailed(true);
        setNotice("配置已保存。");
        setError(`打开组合行情失败：${String(e)}。可重试打开。`);
      }
    }
  }
  async function submit(wantsOpen: boolean) {
    if (!available || !lock.acquire()) return;
    const errors = validMatch(match);
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      setExpanded(true);
      setError("请补充并核对匹配说明。");
      lock.release();
      return;
    }
    const submission: Submission = {
      catalog_id: selected!.catalog_id,
      provider_symbol: selected!.provider_symbol,
      match: matchFields(match),
    };
    setBusy(true);
    setError("");
    setOpenFailed(false);
    try {
      let mapping =
        saved.current?.signature === signature(submission)
          ? saved.current.mapping
          : null;
      if (!mapping) {
        try {
          mapping = await api<SavedMapping>(
            `/market-data/datasets/${dataset.id}/mappings`,
            { catalog_id: submission.catalog_id, match: submission.match },
          );
          if (
            !/^[a-f0-9]{64}$/.test(mapping.id) ||
            !mapping.current_account ||
            mapping.target_identity?.provider_symbol !==
              submission.provider_symbol
          )
            throw Error("保存响应不完整，请核查保存结果。");
        } catch (e: any) {
          if (mounted.current) {
            if (!e.status || e.status >= 500 || e.code === "INVALID_RESPONSE")
              setUncertain(submission);
            setError(
              String(e) +
                (!e.status || e.status >= 500
                  ? "；提交结果待核查，请先核查保存结果。"
                  : ""),
            );
          }
          return;
        }
      }
      if (!mounted.current) return;
      accepted(mapping, submission);
      if (wantsOpen) await open(mapping);
      else navigate(back, { saved: true });
    } finally {
      lock.release();
      if (mounted.current) setBusy(false);
    }
  }
  async function reconcile() {
    if (!uncertain || !lock.acquire()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ items: SavedMapping[] }>(
        `/market-data/datasets/${dataset.id}/mappings`,
      );
      if (!mounted.current) return;
      const found = result.items.find(
        (row) =>
          row.current_account &&
          row.target_identity.provider_symbol === uncertain.provider_symbol &&
          matchKey(row.match) === matchKey(uncertain.match),
      );
      if (found) {
        accepted(found, uncertain);
        setNotice("已确认配置保存成功，可继续打开图表或返回。");
      } else {
        setUncertain(null);
        setNotice(
          "暂未查到本次配置，可用原配置重试保存；相同配置不会重复建立映射。",
        );
      }
    } catch (e) {
      if (mounted.current)
        setError(`核查失败：${String(e)}。请再次核查保存结果。`);
    } finally {
      lock.release();
      if (mounted.current) setBusy(false);
    }
  }
  function field(key: keyof ProductMatch, title: string, children: ReactNode) {
    return (
      <label className="dc-mapping-field" key={key}>
        {title}
        {children}
        {fieldErrors[key] && (
          <small className="error" role="alert">
            {fieldErrors[key]}
          </small>
        )}
      </label>
    );
  }
  function text(
    key:
      "underlying" | "quote_currency" | "historical_evidence" | "live_evidence",
    title: string,
    url = false,
  ) {
    return field(
      key,
      title,
      <NativeInput
        aria-label={title}
        required
        type={url ? "url" : "text"}
        value={match[key]}
        aria-invalid={!!fieldErrors[key]}
        onChange={(e) =>
          edit(key, url ? e.target.value : e.target.value.toUpperCase())
        }
      />,
    );
  }
  const errors = readError || catalog.error;
  return (
    <section className="data-center dc-mapping-page">
      <header className="dc-mapping-header">
        <NativeButton onClick={() => navigate(back)}>返回组合行情</NativeButton>
        <h1>
          配置实时来源 · {dataset.display_symbol || dataset.logical_symbol}
        </h1>
        <p>为自建历史选择后续行情来源。</p>
      </header>
      <div className="dc-mapping-scroll">
        {errors && (
          <p role="alert" className="error">
            {errors}
          </p>
        )}
        <fieldset disabled={frozen} className="dc-mapping-fields">
          {current.length > 1 && (
            <label>
              使用已保存配置
              <NativeSelect
                aria-label="使用已保存配置"
                value={mappingId}
                onChange={(e) => restore(e.target.value)}
              >
                <option value="">新建配置 / 选择已有配置</option>
                {current.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.target_display_symbol ||
                      row.target_identity.provider_symbol}{" "}
                    · {row.id.slice(0, 8)}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {!!mappings.length && !current.length && (
            <p role="status">已有配置属于其他账户，请为当前账户重新选择。</p>
          )}
          <section className="dc-mapping-sources" aria-label="历史与实时来源">
            <div className="dc-mapping-source">
              <span>历史来源</span>
              <div>
                <strong>
                  {dataset.display_symbol || dataset.logical_symbol}
                </strong>
                <small>
                  {names[dataset.identity.source]} ·{" "}
                  {dataset.provider_display_symbol ||
                    dataset.identity.provider_symbol}{" "}
                  · {dataset.identity.basis.toUpperCase()} ·{" "}
                  {phase(dataset.aggregation_calendar)}
                </small>
              </div>
              <small>固定历史</small>
            </div>
            <div className="dc-mapping-source">
              <span>实时来源</span>
              <div>
                <strong>
                  {selected?.display_symbol ||
                    selected?.provider_symbol ||
                    "OANDA Practice"}
                </strong>
                <small>
                  {selected
                    ? `${selected.label} · ${selected.provider_symbol} · Bid`
                    : checking
                      ? "正在核对原品种…"
                      : "选择用于接续的当前账户品种"}
                </small>
              </div>
              {catalogReady && (
                <NativeCatalogPicker
                  source="oanda"
                  query={
                    dataset.provider_display_symbol || dataset.logical_symbol
                  }
                  asset={
                    dataset.asset_class === "metal"
                      ? "commodity"
                      : dataset.asset_class
                  }
                  label={selected ? "更换" : "选择品种"}
                  disabled={frozen || checking}
                  onSelect={pick}
                />
              )}
            </div>
          </section>
          {selectionError && (
            <p className="error" role="alert">
              {selectionError}
            </p>
          )}
          {catalog.loading && !catalog.data ? (
            <p role="status">正在读取账户目录…</p>
          ) : catalog.data?.requires_refresh ? (
            <section className="dc-mapping-empty">
              <h2>先读取可用品种</h2>
              <p>尚未读取当前 OANDA 账户的品种目录。</p>
              <NativeButton
                onClick={() => void refreshDirectory()}
                disabled={frozen}
              >
                读取品种
              </NativeButton>
            </section>
          ) : (
            <div className="dc-mapping-catalog">
              <small>
                {catalog.error ? "账户目录读取失败" : "当前账户目录已读取"}
              </small>
              <NativeButton
                onClick={() => void refreshDirectory()}
                disabled={frozen}
              >
                刷新目录
              </NativeButton>
            </div>
          )}
          {selected && (
            <>
              {mismatch && (
                <p className="error" role="alert">
                  所选实时品种与历史标的、币种或资产类别不匹配，请更换品种。
                </p>
              )}
              <section className="dc-mapping-facts" aria-label="产品核对">
                <div>
                  <span>标的</span>
                  <strong>{match.underlying || "待补充"}</strong>
                </div>
                <div>
                  <span>报价币种</span>
                  <strong>{match.quote_currency || "待补充"}</strong>
                </div>
                <div>
                  <span>实时精度</span>
                  <strong>{selected.precision} 位小数</strong>
                </div>
                <div>
                  <span>价格口径</span>
                  <strong>Bid 原价接续</strong>
                </div>
              </section>
              <section className="dc-mapping-proof">
                <div className="dc-mapping-proof-head">
                  <div>
                    <strong>匹配说明</strong>
                    <small>
                      {match.historical_evidence &&
                      match.live_evidence &&
                      match.rationale
                        ? "核对两来源的产品类型及依据"
                        : "首次配置需补充产品依据"}
                    </small>
                  </div>
                  <NativeButton
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded
                      ? "收起"
                      : match.rationale
                        ? "查看 / 修改"
                        : "补充说明"}
                  </NativeButton>
                </div>
                {expanded && (
                  <div className="dc-mapping-proof-fields">
                    {!sourcePair && (
                      <>
                        {text("underlying", "标的代码")}
                        {text("quote_currency", "报价币种")}
                      </>
                    )}
                    {(["historical_product", "live_product"] as const).map(
                      (key, index) =>
                        field(
                          key,
                          index ? "实时产品类型" : "历史产品类型",
                          <NativeSelect
                            aria-label={index ? "实时产品类型" : "历史产品类型"}
                            value={match[key]}
                            onChange={(e) => edit(key, e.target.value)}
                          >
                            <option value="">选择产品类型</option>
                            {products.map(([v, title]) => (
                              <option key={v} value={v}>
                                {title}
                              </option>
                            ))}
                          </NativeSelect>,
                        ),
                    )}
                    {field(
                      "relationship",
                      "产品关系",
                      <NativeSelect
                        aria-label="产品关系"
                        value={match.relationship}
                        onChange={(e) => edit("relationship", e.target.value)}
                      >
                        <option value="">请核对产品关系</option>
                        <option value="same_product">相同产品</option>
                        <option value="same_underlying_different_product">
                          相同标的、不同产品
                        </option>
                      </NativeSelect>,
                    )}
                    {text("historical_evidence", "历史产品官方依据", true)}
                    {text("live_evidence", "实时产品官方依据", true)}
                    {field(
                      "rationale",
                      "核对说明",
                      <NativeTextarea
                        aria-label="核对说明"
                        required
                        minLength={10}
                        maxLength={1000}
                        rows={3}
                        value={match.rationale}
                        aria-invalid={!!fieldErrors.rationale}
                        onChange={(e) => edit("rationale", e.target.value)}
                      />,
                    )}
                  </div>
                )}
              </section>
              <label className="dc-mapping-confirm">
                <NativeInput
                  aria-label="已核对产品和 Bid 口径，接受两来源的原价差异"
                  type="checkbox"
                  required
                  checked={match.reviewed}
                  disabled={frozen || !available}
                  onChange={(e) => edit("reviewed", e.target.checked)}
                />
                <span>已核对产品和 Bid 口径，接受两来源的原价差异。</span>
              </label>
              {fieldErrors.reviewed && (
                <small role="alert" className="error">
                  {fieldErrors.reviewed}
                </small>
              )}
            </>
          )}
        </fieldset>
        <p className="dc-mapping-note">
          保存配置不会启动采集；打开图表后按需接续行情。
        </p>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert" ref={errorRef} tabIndex={-1}>
            {error}
          </p>
        )}
      </div>
      <footer className="dc-mapping-actions">
        <NativeButton disabled={busy} onClick={() => navigate(back)}>
          取消
        </NativeButton>
        <div>
          {uncertain ? (
            <NativeButton
              primary
              disabled={busy}
              onClick={() => void reconcile()}
            >
              核查保存结果
            </NativeButton>
          ) : (
            <>
              <NativeButton
                disabled={busy || centerBusy || !available}
                onClick={() => void submit(false)}
              >
                仅保存
              </NativeButton>
              <NativeButton
                primary
                disabled={busy || centerBusy || !available}
                onClick={() => void submit(true)}
              >
                {busy
                  ? "正在处理…"
                  : openFailed
                    ? "重试打开图表"
                    : "保存并打开图表"}
              </NativeButton>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
