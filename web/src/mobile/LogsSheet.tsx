import { sourceLabel } from "./marketIdentity";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Copy, Download, Search } from "lucide-react";
import MobileSheet from "./MobileSheet";
import { Button } from "./components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./components/ui/input-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { logSnapshot, subscribeLogs, refreshLogs, type LogEntry } from "./logs";
const time = (value: number) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const label = (row: LogEntry) =>
  row.result === "recovery"
    ? "恢复"
    : row.level === "error"
      ? "失败"
      : row.level === "warning"
        ? "注意"
        : row.result === "success"
          ? "成功"
          : "记录";
function LogRow({ row }: { row: LogEntry }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <Collapsible className="mobile-log-row">
      <CollapsibleTrigger
        render={<Button variant="plain" className="mobile-log-summary" />}
      >
        <span>
          <time>{new Date(row.at).toLocaleTimeString("zh-CN", {hour12:false})}</time>
          <em data-level={row.level}>{label(row)}</em>
          <strong>{row.action}</strong>
          {row.count > 1 && <small>×{row.count}</small>}
        </span>
        <span>
          {[row.object, sourceLabel(row.source), row.message].filter(Boolean).join(" · ")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mobile-log-detail">
          <dl className="mobile-facts">
            <div>
              <dt>模块</dt>
              <dd>{row.module}</dd>
            </div>
            <div>
              <dt>首次 / 最近</dt>
              <dd>
                {time(row.firstAt)} / {time(row.at)}
              </dd>
            </div>
            {row.source && <div><dt>行情来源</dt><dd>{sourceLabel(row.source)}</dd></div>}
            {/AKShare/i.test(row.source || "") && <div><dt>采集通道</dt><dd>AKShare</dd></div>}
            {row.code && (
              <div>
                <dt>错误码</dt>
                <dd>{row.code}</dd>
              </div>
            )}
            {row.path && (
              <div>
                <dt>接口</dt>
                <dd>{row.path}</dd>
              </div>
            )}
            {row.elapsedMs != null && (
              <div>
                <dt>耗时</dt>
                <dd>{row.elapsedMs}ms</dd>
              </div>
            )}
            {row.requestId && (
              <div>
                <dt>请求</dt>
                <dd>{row.requestId}</dd>
              </div>
            )}
            {row.relatedId && (
              <div>
                <dt>关联异常</dt>
                <dd>{row.relatedId}</dd>
              </div>
            )}
            {(row.webVersion || row.appVersion) && (
              <div>
                <dt>版本</dt>
                <dd>
                  {[row.webVersion, row.appVersion].filter(Boolean).join(" · ")}
                </dd>
              </div>
            )}
          </dl>
          <Button
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(JSON.stringify(row, null, 2))
                .then(() => setCopied(true))
                .catch(() => setError("复制失败，请使用导出"))
            }
          >
            <Copy aria-hidden="true" />
            {copied ? "已复制" : "复制条目"}
          </Button>
          {error && <p role="alert">{error}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
export default function LogsSheet({
  open,
  close,
  records,
  onClosed,
}: {
  open: boolean;
  close(): void;
  records(): void;
  onClosed(): void;
}) {
  useEffect(() => {
    if (open) refreshLogs();
  }, [open]);
  const state = useSyncExternalStore(subscribeLogs, logSnapshot, logSnapshot);
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [exported, setExported] = useState(false),
    [error, setError] = useState("");
  const rows = state.rows.filter(
    (row) =>
      (filter !== "errors" || row.level !== "info") &&
      [row.action, row.message, row.module, row.object, row.source, sourceLabel(row.source), row.code]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <MobileSheet
      open={open}
      close={close}
      title="日志"
      fullHeight
      onClosed={onClosed}
    >
      <div className="mobile-logs">
        <div className="mobile-log-tools">
          <ToggleGroup
            value={[filter]}
            onValueChange={(v) => v[0] && setFilter(v[0])}
            aria-label="日志范围"
          >
            <ToggleGroupItem value="all">全部</ToggleGroupItem>
            <ToggleGroupItem value="errors">异常</ToggleGroupItem>
          </ToggleGroup>
          <Button
            variant="ghost"
            aria-label="导出脱敏日志"
            onClick={() => {
              try {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        {
                          exportedAt: new Date().toISOString(),
                          timezone:
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                          entries: state.rows,
                        },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `market-watch-logs-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setExported(true);
              } catch {
                setError("导出失败，请重试");
              }
            }}
          >
            <Download aria-hidden="true" />
            {exported ? "已导出" : "导出"}
          </Button>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="搜索日志"
            placeholder="搜索操作、品种或原因"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
        <p className="data-caption">
          仅本机 · 最近7天，最多1000条 · 时间按本机时区
        </p>
        {state.memoryOnly && (
          <p role="status">本机存储不可用，当前日志仅保留在内存。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div>
          {rows.map((row, i) => (
            <div key={row.id}>
              {(!i ||
                new Date(row.at).toDateString() !==
                  new Date(rows[i - 1].at).toDateString()) && (
                <h3 className="mobile-log-date">
                  {new Date(row.at).toLocaleDateString("zh-CN")}
                </h3>
              )}
              <LogRow row={row} />
            </div>
          ))}
        </div>
        {!rows.length && (
          <p className="data-caption">
            {state.ready
              ? query || filter !== "all"
                ? "没有符合条件的日志"
                : "暂无日志"
              : "正在读取日志…"}
          </p>
        )}
        <Button variant="ghost" onClick={records}>
          查看告警记录
        </Button>
      </div>
    </MobileSheet>
  );
}
