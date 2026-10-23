import { useEffect, useRef, useState, type ReactNode } from "react";
import { Feedback } from "./Center";
import { CreationCatalog, type CatalogItem, type CatalogFilters } from "./CreationCatalog";
import { api } from "./api";
import { NativeButton, NativeInput, NativeSelect, NativeTextarea } from "./NativeControls";
import { centerReturn } from "./navigation";
import { useActionLock, useCenter, useDirtyForm, useMounted, useNavigate, useParams, useSearchParams } from "./router";
import { useSnapshot } from "./useSnapshot";
import { names, phase, type Dataset, type Page } from "./types";
import { initialMatch, matchFields, matchKey, products, validMatch, type ProductMatch,
  type SavedMapping, type MatchCheck, type CatalogSnapshot } from "./mapping";
import "./mapping.css";

type Submission = { catalog_id: string; match: ProductMatch; provider_symbol: string;
  snapshot: CatalogSnapshot; reuse_mapping_id?: string };
type ExistingComposite = { id: string; mapping: { id: string } };

export function MappingForm() {
  const { id } = useParams(), { workspace, target } = useCenter();
  const dataset = useSnapshot<Dataset>(`/market-data/center/datasets/${id}`);
  const mappings = useSnapshot<{ items: SavedMapping[] }>(`/market-data/datasets/${id}/mappings`);
  if (!dataset.data || !mappings.data) return <section className="data-center"><h1>配置实时来源</h1>
    <Feedback error={dataset.error || mappings.error} loading={dataset.loading || mappings.loading} empty /></section>;
  return <MappingEditor key={`${id}:${workspace}:${target}`} dataset={dataset.data}
    mappings={mappings.data.items} readError={dataset.error || mappings.error} />;
}

function savedDraft(row: SavedMapping): ProductMatch {
  return { ...matchFields(row.match), ...row.note && {
    rationale: row.note.rationale, historical_evidence: row.note.historical_evidence,
    live_evidence: row.note.live_evidence }, reviewed: false };
}
function MappingEditor({ dataset, mappings, readError }: { dataset: Dataset; mappings: SavedMapping[]; readError: string }) {
  const current = mappings.filter(row => row.current_account && row.valid_for_selection);
  const initial = useRef(current.length === 1 ? current[0] : null).current;
  const [mappingId, setMappingId] = useState(initial?.id || "");
  const [match, setMatch] = useState<ProductMatch>(() => initial ? savedDraft(initial) : initialMatch(dataset));
  const [selected, setSelected] = useState<CatalogItem | null>(null), [step, setStep] = useState(1);
  const [filters, setFilters] = useState<CatalogFilters>({ source: "oanda", query: dataset.identity.provider_symbol,
    asset: dataset.asset_class === "metal" ? "commodity" : dataset.asset_class });
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false), [savedEpoch, setSavedEpoch] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selectionError, setSelectionError] = useState(""), [hydrating, setHydrating] = useState(!!initial);
  const [check, setCheck] = useState<{ result: MatchCheck; signature: string } | null>(null);
  const [checking, setChecking] = useState(false), [recheck, retryCheck] = useState(0);
  const [uncertain, setUncertain] = useState<Submission | null>(null), [openFailed, setOpenFailed] = useState(false);
  const { apply, clearDirty, busy: centerBusy } = useCenter(), navigate = useNavigate(), [params] = useSearchParams();
  const mounted = useMounted(), lock = useActionLock(), errorRef = useRef<HTMLParagraphElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0), initialized = useRef(false), hydrateProduct = useRef(!initial);
  const lastSnapshot = useRef("");
  const saved = useRef<{ signature: string; mapping: SavedMapping } | null>(null), uncertainOpen = useRef(false);
  const composites = useSnapshot<{ items: ExistingComposite[] }>(`/market-data/center/composites?dataset_id=${dataset.id}&page_size=100`);
  const back = centerReturn(params, "/market-data?tab=composite&view=candidates");
  const frozen = busy || centerBusy || !!uncertain;
  useDirtyForm("mapping", dirty, savedEpoch);
  const localErrors = validMatch(match), draftKey = matchKey(match);
  const checkKey = selected ? selected.catalog_id + ":" + draftKey : "";
  const result = check?.signature === checkKey ? check.result : null;
  const ready = !!selected && !!result && result.status === "ready" && !Object.keys(localErrors).length && !selectionError && !hydrating && !checking;
  const existing = composites.data?.items.find(row => row.mapping.id === mappingId);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (step === 2) heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (!mappingId || !mappings.some(row => row.id === mappingId && !row.current_account)) return;
    ++generation.current; setSelected(null); setMappingId(""); setCheck(null); saved.current = null;
    setSelectionError("实时账户已变化，请重新选择当前账户品种。"); setStep(1);
  }, [mappings, mappingId]);

  async function restore(id: string, user = true) {
    const row = current.find(item => item.id === id), token = ++generation.current;
    setMappingId(id); setSelected(null); setCheck(null); saved.current = null; lastSnapshot.current = "";
    setError(""); setSelectionError(""); setNotice(""); setOpenFailed(false);
    setMatch(row ? savedDraft(row) : initialMatch(dataset)); hydrateProduct.current = !row;
    if (user) setDirty(true);
    if (!row) { setHydrating(false); return; }
    setHydrating(true);
    try {
      const response = await api<Page<CatalogItem>>(`/market-data/history-catalog?source=oanda&query=${encodeURIComponent(row.target_identity.provider_symbol)}&page_size=100`);
      if (!mounted.current || token !== generation.current) return;
      const entry = response.items.find(item => item.provider_symbol === row.target_identity.provider_symbol);
      if (!entry) throw Error("原品种已不在当前账户目录中，请重新选择。");
      setSelected(entry);
    } catch (e) { if (mounted.current && token === generation.current) setSelectionError(String(e)); }
    finally { if (mounted.current && token === generation.current) setHydrating(false); }
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (initial) void restore(initial.id, false);
  }, []);

  // Poll only source facts; hydrate a new selection once, preserving later edits.
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(), token = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const signature = checkKey;
    async function validate() {
      setChecking(true);
      try {
        const response = await api<MatchCheck>(`/market-data/datasets/${dataset.id}/mapping-check`,
          { catalog_id: selected!.catalog_id, match: hydrateProduct.current ? null : matchFields(match) }, controller.signal);
        if (controller.signal.aborted || !mounted.current || token !== generation.current) return;
        const snapshot = JSON.stringify(response.snapshot);
        if (lastSnapshot.current && lastSnapshot.current !== snapshot) {
          saved.current = null; setMappingId(""); setMatch(old => ({ ...old, reviewed: false }));
          setNotice("账户、品种、精度或产品属性已变化，已重新核对；请检查新属性。");
        }
        lastSnapshot.current = snapshot;
        setSelectionError("");
        setSelected(old => old ? { ...old, precision: response.snapshot.precision } : old);
        if (hydrateProduct.current) {
          hydrateProduct.current = false;
          setMatch(old => ({ ...response.suggestion, rationale: old.rationale,
            historical_evidence: old.historical_evidence, live_evidence: old.live_evidence }));
        } else setCheck({ result: response, signature });
      } catch (e) {
        if (!controller.signal.aborted && mounted.current && token === generation.current) {
          setCheck(null); setSelectionError(`核对失败：${String(e)}`);
        }
      } finally {
        if (!controller.signal.aborted && mounted.current && token === generation.current) {
          setChecking(false); timer = setTimeout(validate, 10000);
        }
      }
    }
    void validate();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected?.catalog_id, draftKey, recheck]);

  function pick(entry: CatalogItem) {
    if (frozen || selected?.catalog_id === entry.catalog_id) return;
    ++generation.current; hydrateProduct.current = true; lastSnapshot.current = "";
    saved.current = null; setMappingId(""); setSelected(entry); setCheck(null); setHydrating(false);
    setMatch(old => ({ ...initialMatch(dataset), rationale: old.rationale }));
    setDirty(true); setError(""); setSelectionError(""); setNotice(""); setOpenFailed(false);
  }
  function edit<K extends keyof ProductMatch>(key: K, value: ProductMatch[K]) {
    // A manual edit wins even while the first automatic suggestion is pending.
    if (["underlying", "quote_currency", "historical_product", "live_product", "relationship", "reviewed"].includes(key))
      hydrateProduct.current = false;
    setMatch(old => ({ ...old, [key]: value, ...(["underlying", "quote_currency", "historical_product", "live_product", "relationship"].includes(key) ? { reviewed: false } : {}) }));
    setDirty(true); setError(""); setNotice(""); setOpenFailed(false);
  }
  function signature(submission: Submission) { return submission.catalog_id + ":" + matchKey(submission.match); }
  function accepted(mapping: SavedMapping, submission: Submission) {
    saved.current = { signature: signature(submission), mapping }; setMappingId(mapping.id);
    setUncertain(null); setDirty(false); setSavedEpoch(v => v + 1); clearDirty();
  }
  async function open(mapping: SavedMapping) {
    if (!mounted.current) return;
    setNotice("配置已保存，正在建立或打开组合行情…");
    try {
      const clientKey = "market-watch-composite-chart-client";
      let client = sessionStorage.getItem(clientKey);
      if (!client) { client = `mc-${crypto.randomUUID()}`; sessionStorage.setItem(clientKey, client); }
      if (uncertainOpen.current) {
        await api(`/market-data/center/composites?dataset_id=${dataset.id}&page_size=100`);
        if (!mounted.current) return;
      }
      uncertainOpen.current = true;
      const row = await api<{ id: string; preparation: { status: string } }>("/market-data/composites/use", {
        dataset_id: dataset.id, mapping_id: mapping.id, client });
      if (!mounted.current) return;
      if (!/^[a-f0-9]{64}$/.test(row.id)) throw Error("打开结果不完整，请核查后重试");
      uncertainOpen.current = false;
      setNotice(row.preparation.status === "queried" ? "配置已保存，正在打开图表。覆盖完整及策略就绪单独核验。" : "配置已保存，接续准备中；图表可读取已发布历史。");
      await apply(`MWC:${row.id}`, "M1");
    } catch (e) {
      if (mounted.current) { setOpenFailed(true); setNotice("配置已保存。"); setError(`打开组合行情失败：${String(e)}。可重试打开。`); }
    }
  }
  async function submit(wantsOpen: boolean) {
    if (!ready || !lock.acquire()) return;
    const submission: Submission = { catalog_id: selected!.catalog_id, provider_symbol: selected!.provider_symbol,
      match: matchFields(match), snapshot: result!.snapshot, ...(mappingId ? { reuse_mapping_id: mappingId } : {}) };
    setBusy(true); setError(""); setOpenFailed(false);
    try {
      let mapping = saved.current?.signature === signature(submission) ? saved.current.mapping : null;
      if (!mapping) {
        try {
          mapping = await api<SavedMapping>(`/market-data/datasets/${dataset.id}/mappings`, {
            catalog_id: submission.catalog_id, match: submission.match, snapshot: submission.snapshot,
            reuse_mapping_id: submission.reuse_mapping_id });
          if (!/^[a-f0-9]{64}$/.test(mapping.id) || !mapping.current_account || mapping.target_identity?.provider_symbol !== submission.provider_symbol)
            throw Error("保存响应不完整，请核查保存结果。");
        } catch (e: any) {
          if (mounted.current) {
            if (!e.status || e.status >= 500 || e.code === "INVALID_RESPONSE") setUncertain(submission);
            setError(String(e) + (!e.status || e.status >= 500 ? "；提交结果待核查，请先核查保存结果。" : ""));
            retryCheck(v => v + 1);
          }
          return;
        }
      }
      if (!mounted.current) return;
      accepted(mapping, submission);
      if (wantsOpen) await open(mapping); else navigate(back, { saved: true });
    } finally { lock.release(); if (mounted.current) setBusy(false); }
  }
  async function reconcile() {
    if (!uncertain || !lock.acquire()) return;
    setBusy(true); setError("");
    try {
      const response = await api<{ items: SavedMapping[] }>(`/market-data/datasets/${dataset.id}/mappings`);
      if (!mounted.current) return;
      const found = response.items.find(row => row.current_account && row.target_identity.provider_symbol === uncertain.provider_symbol &&
        matchKey({ ...matchFields(row.match), ...(row.note || {}), reviewed: uncertain.match.reviewed }) === matchKey(uncertain.match) &&
        (!uncertain.reuse_mapping_id || row.id === uncertain.reuse_mapping_id));
      if (found) { accepted(found, uncertain); setNotice("已确认配置保存成功，可继续打开图表或返回。"); }
      else { setUncertain(null); setNotice("暂未查到本次配置，可用原配置重试保存；相同运行配置不会重复建立映射。"); }
    } catch (e) { if (mounted.current) setError(`核查失败：${String(e)}。请再次核查保存结果。`); }
    finally { lock.release(); if (mounted.current) setBusy(false); }
  }
  function field(key: keyof ProductMatch, title: string, children: ReactNode) {
    const message = localErrors[key] || result?.errors[key];
    return <label className="dc-mapping-field" key={key}>{title}{children}
      {message && <small className="error" role="alert">{message}</small>}</label>;
  }
  function text(key: "underlying" | "quote_currency" | "historical_evidence" | "live_evidence", title: string, url = false) {
    return field(key, title, <NativeInput aria-label={title} disabled={frozen} type={url ? "url" : "text"}
      value={match[key] || ""} onChange={e => edit(key, (url ? e.target.value : e.target.value.toUpperCase()) || (url ? null : ""))} />);
  }
  const productFields = <>
    {text("underlying", "标的代码")}{text("quote_currency", "报价币种")}
    {(["historical_product", "live_product"] as const).map((key, index) => field(key, index ? "实时产品类型" : "历史产品类型",
      <NativeSelect disabled={frozen} aria-label={index ? "实时产品类型" : "历史产品类型"} value={match[key]} onChange={e => edit(key, e.target.value)}>
        <option value="">待核实</option>{products.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </NativeSelect>))}
    {field("relationship", "产品关系", <NativeSelect disabled={frozen} aria-label="产品关系" value={match.relationship} onChange={e => edit("relationship", e.target.value)}>
      <option value="">待核实</option><option value="same_product">同类报价产品</option>
      <option value="same_underlying_different_product">同标的、不同报价产品</option></NativeSelect>)}
  </>;
  return <section className="data-center dc-create-page dc-mapping-page">
    <header className="dc-create-title"><NativeButton onClick={() => navigate(back)}>返回组合行情</NativeButton>
      <h1>配置实时来源 · {dataset.display_symbol || dataset.logical_symbol}</h1></header>
    <div className="dc-create-steps" aria-label="配置步骤"><span aria-current={step === 1 ? "step" : undefined}>① 选择实时品种</span>
      <span aria-current={step === 2 ? "step" : undefined}>② 配置并创建</span></div>
    <div className="dc-mapping-history"><strong>历史来源 · {names[dataset.identity.source]}</strong>
      <span>{dataset.identity.provider_symbol} · Bid · {phase(dataset.aggregation_calendar)}</span></div>
    {step === 1 ? <>
      {current.length > 1 && <label className="dc-mapping-saved">使用已保存配置<NativeSelect disabled={frozen} aria-label="使用已保存配置" value={mappingId} onChange={e => void restore(e.target.value)}>
        <option value="">请明确选择已有配置或下方品种</option>{current.map(row => <option key={row.id} value={row.id}>
          {row.target_identity.provider_symbol} · {row.id.slice(0, 8)}</option>)}</NativeSelect></label>}
      {mappings.length > 0 && current.length === 0 && <p role="status">已有配置不适用于当前账户或产品规则，请重新选择并核对。</p>}
      <CreationCatalog fixedSource="oanda" autoRefresh initialFilters={filters} saveFilters={setFilters}
        selected={selected} select={pick} disabled={frozen} onRefresh={() => retryCheck(v => v + 1)} />
    </> : <>
      <div className="dc-create-selection"><h2 ref={heading} tabIndex={-1}>{selected?.provider_symbol} · OANDA Practice</h2>
        <NativeButton disabled={frozen} onClick={() => setStep(1)}>更换品种</NativeButton></div>
      <div className="dc-create-config-scroll"><div className="dc-create-config-grid">
        <div className="dc-create-fields">
          <fieldset disabled={frozen}><legend>产品配置</legend><div className="dc-mapping-proof-fields">{productFields}</div></fieldset>
          <fieldset><legend>来源与接续</legend><dl className="dc-create-facts">
            <dt>实时来源</dt><dd>OANDA · Practice · 当前账户</dd><dt>准确品种</dt><dd>{selected?.provider_symbol}</dd>
            <dt>实时精度</dt><dd>{selected?.precision} 位小数 · 来源属性</dd><dt>价格口径</dt><dd>Bid 原价接续</dd>
            <dt>日线划分</dt><dd>{phase(dataset.aggregation_calendar)} · 沿用历史规则</dd>
          </dl><p>历史发布版本与接续点在首次使用时由服务端原子固定；此处尚未固定。</p></fieldset>
          {check?.result.difference && <section className="dc-create-notice" aria-label="已知产品差异"><p>{check.result.difference}</p>
            <label className="dc-mapping-confirm"><NativeInput type="checkbox" disabled={frozen} checked={match.reviewed}
              aria-label="确认黄金报价产品差异并接受 Bid 原价接续" onChange={e => { const checked = e.target.checked; edit("reviewed", checked); }} />
              确认上述黄金报价产品差异，接受 Bid 原价接续。</label></section>}
          <section className="dc-mapping-proof"><div className="dc-mapping-proof-head"><strong>匹配详情</strong>
            <NativeButton aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? "收起匹配详情" : "查看匹配详情"}</NativeButton></div>
            {expanded && <div className="dc-mapping-proof-fields">
              <div className="dc-mapping-evidence">{check?.result.sources.map(source => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.scope}</a></p>)}
                <p>资料只在所示准确来源及产品规则范围内适用；补充链接需核实其适用性。</p></div>
              {text("historical_evidence", "补充历史产品资料（选填）", true)}{text("live_evidence", "补充实时产品资料（选填）", true)}
            </div>}</section>
          {field("rationale", "备注（选填）", <NativeTextarea aria-label="备注（选填）" disabled={frozen} maxLength={1000} rows={3}
            value={match.rationale} onChange={e => edit("rationale", e.target.value)} />)}
        </div>
        <aside className="dc-create-summary" aria-label="创建摘要"><h2>创建摘要</h2><dl className="dc-create-facts">
          <dt>历史来源</dt><dd>{names[dataset.identity.source]} · {dataset.identity.provider_symbol}</dd>
          <dt>实时来源</dt><dd>OANDA Practice · {selected?.provider_symbol}</dd><dt>价格</dt><dd>Bid · 保留两来源原价差异</dd>
          <dt>日线划分</dt><dd>{phase(dataset.aggregation_calendar)}</dd><dt>匹配结论</dt><dd>{check?.result.conclusion || "正在核对"}</dd>
        </dl><div role="status">{checking || !result ? "正在核对" : ready ? "可以创建" : `待补充：${Object.values({ ...result.errors, ...localErrors }).join("；")}`}</div>
          {!checking && !ready && <NativeButton onClick={() => retryCheck(v => v + 1)}>重新核对</NativeButton>}
          <p>保存配置、图表就绪、覆盖完整及策略就绪分别检查。</p>
        </aside>
      </div></div>
    </>}
    <div className="dc-mapping-feedback">
      {(readError || selectionError) && <p role="alert" className="error">{readError || selectionError}</p>}
      {hydrating && <p role="status">正在核对已保存品种…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p className="error" role="alert" ref={errorRef} tabIndex={-1}>{error}</p>}
    </div>
    <footer className="dc-create-actionbar dc-mapping-actions">
      {step === 1 ? <><span>{selected ? `已选 ${selected.provider_symbol} · OANDA Practice` : "选择当前账户可用品种"}</span>
        <NativeButton disabled={busy} onClick={() => navigate(back)}>取消</NativeButton>
        <NativeButton primary disabled={frozen || !selected || hydrating} onClick={() => setStep(2)}>配置实时 →</NativeButton></> : <>
        <NativeButton disabled={frozen} onClick={() => setStep(1)}>返回选择品种</NativeButton>
        <NativeButton disabled={busy} onClick={() => navigate(back)}>取消</NativeButton>
        <span>仅保存不建立组合或采集需求。</span>
        {uncertain ? <NativeButton primary disabled={busy} onClick={() => void reconcile()}>核查保存结果</NativeButton> : <>
          <NativeButton disabled={frozen || !ready} onClick={() => void submit(false)}>仅保存配置</NativeButton>
          <NativeButton primary disabled={frozen || !ready} onClick={() => void submit(true)}>
            {busy ? "正在处理…" : openFailed ? "重试打开图表" : existing ? "打开已有组合" : "创建并打开图表"}</NativeButton></>}
      </>}
    </footer>
  </section>;
}
