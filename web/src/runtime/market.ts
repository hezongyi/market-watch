/** Existing data/history behavior shared directly with the native adapter. */
import {validIndicatorRead} from '../advanced/indicatorRequests';
import {loadNativeHistory,type HistoryCapabilities} from '../advanced/nativeHistoryLoads';
import {apiErrorDetails,errorMessage} from '../api';
import type {ChartAdapter,ChartUpdate} from './chart';
import type {Dispatch,SetStateAction} from 'react';
import type {NativeLoad} from '../advanced/HistoryLoadingNotice';
type Ref<T>={current:T};
const frames = new Set(["M1","M5","M15","M30","H1","H4","D1","W1","MN"]);
export function marketRuntime({api,marketRequests,inflight,historyCapabilities,setNativeLoads,current,nativeLoadEpoch,chart,compositeEstablished,updateChart}: {
 api:<T=any>(path:string,body?:unknown,signal?:AbortSignal)=>Promise<T>;marketRequests:Map<ChartAdapter,Map<number,AbortController>>;
 inflight:Ref<number>;historyCapabilities:Ref<HistoryCapabilities|null>;setNativeLoads:Dispatch<SetStateAction<Record<string,NativeLoad>>>;
 current:Ref<{id:string}|null>;nativeLoadEpoch:Ref<number>;chart:Ref<ChartAdapter|null>;compositeEstablished:(instrument:string)=>void;updateChart:(value:ChartUpdate)=>void;
}) {
async function market(q:any,source:ChartAdapter,context:{id:number;history_client?:string}) {

        const endpoints: Record<string, string> = {
          search: "/market-data/series/search",
          searchPage: "/market-data/series/page",
          resolve: "/market-data/resolve",
          viewport: "/market-data/viewport-session",
          history: "/market-data/history",
          historyCache: "/market-data/history/cache",
          historyDemand: "/market-data/history/demand",
          dataset: "/market-data/dataset",
          activity: "/market-data/activity",
          retry: "/market-data/retry",
          quotes: "/market-data/quotes",
          serverTime: "/readyz",
        };
        if (
          !q ||
          !Object.hasOwn(endpoints, q.op) ||
          JSON.stringify(q).length > 4000 ||
          (q.op === "retry" &&
            !/^[a-zA-Z0-9-]{1,40}$/.test(String(q.args?.id || ""))) ||
          inflight.current >= 8 ||
          (q.native_history !== undefined &&
            (q.series_kind !== "provider" ||
              !q.native_history ||
              typeof q.native_history !== "object" ||
              Array.isArray(q.native_history) ||
              !Number.isInteger(q.native_history.chart_count) ||
              q.native_history.chart_count < 1 ||
              q.native_history.chart_count > 8 ||
              (q.native_history.focused !== null &&
                typeof q.native_history.focused !== "boolean") ||
              typeof q.native_history.historical_navigation !== "boolean")) ||
          (q.history_observation !== undefined &&
            (!q.native_history ||
              !q.history_observation ||
              typeof q.history_observation !== "object" ||
              Array.isArray(q.history_observation) ||
              !["revision", "observed_at", "first", "last"].every(
                (field) =>
                  Number.isSafeInteger(q.history_observation[field]) &&
                  q.history_observation[field] >= 0,
              ) ||
              q.history_observation.first > q.history_observation.last))
        ) {
          throw Object.assign(Error("无效行情请求"),{});
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(context.id, controller);
        inflight.current++;
        try {
          let result;
          if (q.op === "serverTime") {
            const response = await fetch("/readyz", {
              signal: controller.signal,
              credentials: "omit",
              cache: "no-store",
            });
            const health = await response.json();
            if (
              !response.ok ||
              !Number.isSafeInteger(health.time) ||
              health.time <= 0
            )
              throw Error("服务器时间暂不可用");
            result = Math.floor(health.time / 1000);
          } else
            result = await api(
              endpoints[q.op] +
                (q.op === "searchPage"
                  ? "?" + new URLSearchParams({query:String(q.args?.query || ""),
                    kind:["provider","history","composite","all"].includes(q.args?.kind) ? q.args.kind : "provider",
                    source:String(q.args?.source || ""),calendar:String(q.args?.calendar || ""),
                    symbol_type:String(q.args?.symbol_type || ""),cursor:String(q.args?.cursor || ""),
                    page_size:String(Number.isSafeInteger(q.args?.page_size) ? Math.max(1,Math.min(100,q.args.page_size)) : 25),
                    offset:String(Number.isSafeInteger(q.args?.offset) ? q.args.offset : 0)})
                  : q.op === "search"
                    ? "?query=" +
                      encodeURIComponent(String(q.args?.query || "")) +
                      "&kind=" +
                      encodeURIComponent(
                        ["provider", "history", "composite", "all"].includes(
                          q.args?.kind,
                        )
                          ? q.args.kind
                          : "all",
                      ) +
                      (q.args?.source
                        ? "&source=" + encodeURIComponent(String(q.args.source))
                        : "")
                    : q.op === "retry"
                      ? "/" + encodeURIComponent(q.args.id)
                      : ""),
              ["search", "searchPage"].includes(q.op) ? undefined : q.args,
              controller.signal,
            );
          return result;
        } catch (e) {
          throw Object.assign(Error(errorMessage(e)),apiErrorDetails(e));
        } finally {
          sourceRequests.delete(context.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      }
async function data(q:any,source:ChartAdapter,context:{id:number;history_client?:string}) {

        if (
          !q ||
          !validIndicatorRead(q.indicators) ||
          (q.indicator_input_policy !== undefined &&
            !["strict_confirmed_v1", "observed_display_v1"].includes(q.indicator_input_policy)) ||
          (q.indicator_input_policy === "observed_display_v1" &&
            (!["history", "composite"].includes(q.series_kind) || q.input_revision !== undefined)) ||
          (q.provisional !== undefined && typeof q.provisional !== "boolean") ||
          (q.client !== undefined && (typeof q.client !== "string" || q.client.length < 1 || q.client.length > 64)) ||
          (q.indicator_consumers !== undefined && (
            !Array.isArray(q.indicator_consumers) || q.indicator_consumers.length > 64 ||
            q.indicator_consumers.some((consumer: any) => !consumer ||
              typeof consumer.id !== "string" || consumer.id.length < 1 || consumer.id.length > 100 ||
              !Number.isSafeInteger(consumer.generation) || consumer.generation < 0 ||
              !validIndicatorRead([consumer.spec]) ||
              (consumer.purpose !== undefined && !["foreground", "warmup"].includes(consumer.purpose)))
          )) ||
          typeof q.instrument !== "string" ||
          q.instrument.length > 80 ||
          (q.series_kind !== undefined &&
            !["provider", "managed", "history", "composite"].includes(
              q.series_kind,
            )) ||
          (q.display_snapshot_id !== undefined &&
            (q.series_kind !== "composite" ||
              typeof q.display_snapshot_id !== "string" ||
              !/^[a-f0-9]{64}$/.test(q.display_snapshot_id))) ||
          (q.display_retry !== undefined && (q.series_kind !== "composite" ||
            !q.display_retry || typeof q.display_retry !== "object" || Array.isArray(q.display_retry) ||
            Object.keys(q.display_retry).length > 12 || Object.entries(q.display_retry).some(([id,token])=>
              !/^[a-f0-9]{64}$/.test(id) || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)))) ||
          !frames.has(q.timeframe) ||
          !Number.isInteger(q.limit) ||
          q.limit < 1 ||
          q.limit >
            (q.series_kind === "provider"
              ? historyCapabilities.current?.max_bars || 20000
              : 2000) ||
          (q.before !== undefined &&
            (!Number.isSafeInteger(q.before) || q.before <= 0)) ||
          (q.revision_before !== undefined &&
            (!Number.isSafeInteger(q.revision_before) ||
              q.revision_before <= 0)) ||
          (q.revision_after !== undefined &&
            (!Number.isSafeInteger(q.revision_after) ||
              q.revision_after < 0)) ||
          (q.native_reserve !== undefined &&
            (q.series_kind !== "provider" ||
              !q.native_history ||
              !q.native_reserve ||
              typeof q.native_reserve !== "object" ||
              Array.isArray(q.native_reserve) ||
              !Number.isInteger(q.native_reserve.screen_bars) ||
              q.native_reserve.screen_bars < 1 ||
              q.native_reserve.screen_bars > 2000 ||
              ![1, 2].includes(q.native_reserve.batch_screens) ||
              !Number.isInteger(q.native_reserve.warmup_bars) ||
              q.native_reserve.warmup_bars < 0 ||
              q.native_reserve.warmup_bars > 2000 ||
              Object.keys(q.native_reserve).some(
                (k) =>
                  !["screen_bars", "batch_screens", "warmup_bars"].includes(k),
              ) ||
              q.indicators?.length ||
              q.history_observation !== undefined))
        ) {
          throw Object.assign(Error("请求不在允许范围内"),{
              code:
                q?.series_kind === "provider" && q?.limit > 20000
                  ? "NATIVE_HISTORY_CAPACITY_EXCEEDED"
                  : "INVALID_HISTORY_REQUEST",
            });
          return;
        }
        if (inflight.current >= 8) {
          throw Object.assign(Error("行情服务繁忙，请稍后重试"),{ code: "HISTORY_BUSY", status: 503 });
          return;
        }
        const controller = new AbortController();
        if (!marketRequests.has(source)) marketRequests.set(source, new Map());
        const sourceRequests = marketRequests.get(source)!;
        sourceRequests.set(context.id, controller);
        inflight.current++;
        try {
          const result = await (
              q.series_kind === "provider" &&
                q.native_history &&
                !q.native_reserve
                ? (body: unknown, signal: AbortSignal) =>
                    loadNativeHistory(
                      body,
                      signal,
                      historyCapabilities.current!,
                      (progress) =>
                        setNativeLoads((previous) => {
                          const key = q.history_progress_id;
                          if (
                            source !== chart.current ||
                            q.history_progress_epoch !==
                              nativeLoadEpoch.current ||
                            !previous[key]
                          )
                            return previous;
                          return {
                            ...previous,
                            [key]: { ...previous[key], ...progress },
                          };
                        }),
                      {workspace_id:current.current?.id || "",chart_index:String(q.notice_chart_index ?? "")},
                      available=>updateChart({type:'history-load-admitted',id:context.id,available,history_client:context.history_client}),
                    )
                : (body: unknown, signal: AbortSignal) =>
                    api(
                      q.native_reserve ? "/charts/reserve" : "/charts/data",
                      body,
                      signal,
                    )
            )(
              {
                instrument: q.instrument,
                series_kind: q.series_kind || "managed",
                published: q.series_kind !== "provider",
                ...(q.indicator_input_policy !== undefined ? {indicator_input_policy:q.indicator_input_policy} : {}),
                ...(q.provisional !== undefined ? {provisional:q.provisional} : {}),
                ...(q.client !== undefined ? { client: q.client } : {}),
                ...(q.indicator_consumers !== undefined ? { indicator_consumers: q.indicator_consumers } : {}),
                ...(q.series_kind === "composite"
                  ? {
                      composite_revision_id: q.composite_revision_id,
                      input_revision: q.input_revision,
                      display_snapshot_id: q.display_snapshot_id,
                      display_retry: q.display_retry,
                    }
                  : {}),
                ...(typeof q.dataset_start === "number"
                  ? { dataset_start: q.dataset_start }
                  : {}),
                ...(typeof q.calculation_origin === "number"
                  ? { calculation_origin: q.calculation_origin }
                  : {}),
                ...(typeof q.dependency_before === "number"
                  ? { dependency_before: q.dependency_before }
                  : {}),
                timeframe: q.timeframe,
                limit: q.limit,
                ...(q.series_kind === "provider"
                  ? {
                      provider_snapshot_id: q.provider_snapshot_id,
                      countBack: q.countBack,
                      from: q.from,
                      firstDataRequest: q.firstDataRequest === true,
                      ...(q.native_history !== undefined
                        ? {
                            native_history: q.native_history,
                            history_page_bars:
                              q.history_page_bars === 1000 ? 1000 : 4000,
                          }
                        : {}),
                      ...(q.native_reserve !== undefined
                        ? { native_reserve: q.native_reserve }
                        : {}),
                      ...(q.history_observation !== undefined
                        ? { history_observation: q.history_observation }
                        : {}),
                    }
                  : {}),
                indicators: q.indicators || [],
                ...(q.before ? { before: q.before } : {}),
                track_history: q.track_history === true,
                ...(q.revision_after !== undefined
                  ? { revision_after: q.revision_after }
                  : {}),
                ...(q.revision_before
                  ? { revision_before: q.revision_before }
                  : {}),
              },
              controller.signal,
            );
          if (q.series_kind === "composite" && q.client && !controller.signal.aborted && source === chart.current) compositeEstablished(q.instrument);
          return result;
        } catch (e) {
          throw Object.assign(Error(errorMessage(e)),apiErrorDetails(e));
        } finally {
          sourceRequests.delete(context.id);
          if (!sourceRequests.size) marketRequests.delete(source);
          inflight.current--;
        }
      }
return {market,data};
}
