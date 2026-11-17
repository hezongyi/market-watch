import { useState } from "react";
import { api, errorMessage } from "../api";
import type { Dataset } from "../market-data/types";
import type { Profile } from "./cache";
import {
  datasetRow,
  loadManaged,
  managedCode,
  type MarketRow,
} from "./dataMarkets";
import { useSymbolSearch } from "./useSymbolSearch";
import { SymbolSearchPanel, SymbolSearchRow } from "./SymbolSearch";
import SymbolIdentityRow from "./SymbolIdentityRow";
import MobileSheet from "./MobileSheet";
import { Button } from "./components/ui/button";
import { DataEmpty } from "./DataStates";

export default function AlertSymbolPicker({
  profile,
  online,
  open,
  close,
  onClosed,
  pick,
  maintain,
  add,
  recheck,
}: {
  profile: Profile;
  online: boolean;
  open: boolean;
  close(): void;
  onClosed(): void;
  pick(row: MarketRow): Promise<void>;
  maintain(id: string): void;
  add(): void;
  recheck?: number;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState("");
  const [issue, setIssue] = useState<{ id: string; text: string }>();
  const result = useSymbolSearch<Dataset>({
    profile,
    online,
    active: open,
    queryKey: "alert-symbols:" + query + ":" + (recheck || 0),
    identity: (row) => row.id,
    fetchPage: async (cursor, signal) => {
      const page = Number(cursor || 1);
      const value = await api<{ items: Dataset[]; total: number }>(
        "/market-data/center/dataset-summaries?" +
          new URLSearchParams({
            query,
            mobile: "true",
            alert_eligible: "true",
            page: String(page),
            page_size: "25",
          }),
        undefined,
        signal,
      );
      return {
        items: value.items,
        next: page * 25 < value.total ? String(page + 1) : undefined,
      };
    },
  });
  async function select(dataset: Dataset) {
    if (pending || !online) return;
    setIssue(undefined);
    setPending(dataset.id);
    try {
      const row = await loadManaged(datasetRow(dataset));
      if (!row.ticker.startsWith("MWC:")) {
        setIssue({
          id: dataset.id,
          text: row.selectionError || "尚未开启实时，请先到数据详情开启。",
        });
        return;
      }
      await pick(row);
    } catch (error) {
      setIssue({ id: dataset.id, text: errorMessage(error) });
    } finally {
      setPending("");
    }
  }
  return (
    <MobileSheet
      title="选择告警品种"
      description="选择自建行情，再设置触发条件"
      open={open}
      close={close}
      onClosed={onClosed}
      fullHeight
      dismissible={!pending}
    >
      <SymbolSearchPanel
        query={query}
        onQuery={(value) => {
          setQuery(value);
          setIssue(undefined);
        }}
        label="搜索告警品种"
        placeholder="代码、名称、来源、类别"
        loading={result.loading}
        loaded={result.loaded}
        error={result.error}
        retry={result.retry}
        hasNext={Boolean(result.next)}
        loadNext={result.loadNext}
        active={open}
        online={online}
      >
        {result.loaded && !result.items.length && (
          <DataEmpty
            title="没有可创建告警的品种"
            action={
              <Button onClick={add} disabled={!online}>
                添加自建行情
              </Button>
            }
          >
            先在数据页添加自建行情并开启实时，再创建告警。
          </DataEmpty>
        )}
        {result.items.map((dataset) => (
          <div key={dataset.id} className="alert-symbol-result">
            <SymbolSearchRow
              disabled={!online || Boolean(pending)}
              onSelect={() => void select(dataset)}
            >
              <SymbolIdentityRow
                row={dataset}
                code={managedCode(dataset)}
                name={dataset.instrument_name || ""}
                custom
              />
              <span className="alert-picker-note">
                {pending === dataset.id
                  ? "正在核验…"
                  : dataset.continuation?.enabled
                    ? "实时已开启"
                    : "需开启实时"}
              </span>
            </SymbolSearchRow>
            {issue?.id === dataset.id && (
              <div className="alert-picker-issue">
                <p role="alert">{issue.text}</p>
                <Button variant="outline" onClick={() => maintain(dataset.id)}>
                  去数据详情
                </Button>
              </div>
            )}
          </div>
        ))}
      </SymbolSearchPanel>
    </MobileSheet>
  );
}
