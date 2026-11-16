import { useOverlayActive } from "./WatchOverlays";
import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, Plus, Search, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { HeaderIconButton } from "./components/HeaderIconButton";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupButton,
} from "./components/ui/input-group";
import { DataEmpty, DataLoading } from "./DataStates";

export function SymbolAddButton({
  label,
  onClick,
  expanded,
}: {
  label: string;
  onClick(): void;
  expanded?: boolean;
}) {
  return (
    <HeaderIconButton
      icon={Plus}
      label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
    />
  );
}

export function SymbolSearchPanel({
  query,
  resetKey = query,
  onQuery,
  label,
  placeholder = "代码、中文名、来源或类别",
  maxLength = 100,
  filters,
  enhancedFilters,
  children,
  loading,
  loaded,
  error,
  retry,
  hasNext,
  loadNext,
  active,
  online,
  note,
}: {
  query: string;
  resetKey?: string;
  onQuery(value: string): void;
  label: string;
  placeholder?: string;
  maxLength?: number;
  filters?: ReactNode;
  enhancedFilters?: ReactNode;
  children: ReactNode;
  loading: boolean;
  loaded: boolean;
  error: string;
  retry(): void;
  hasNext: boolean;
  loadNext(): void;
  active: boolean;
  online: boolean;
  note?: ReactNode;
}) {
  const overlayActive = useOverlayActive();
  active = active && overlayActive;
  const sentinel = useRef<HTMLDivElement>(null);
  const previousKey = useRef(resetKey);
  useEffect(() => {
    if (previousKey.current !== resetKey) {
      const root = sentinel.current?.closest(".mobile-drawer-scroll");
      if (root) root.scrollTop = 0;
      previousKey.current = resetKey;
    }
  }, [resetKey]);
  const callback = useRef(loadNext);
  callback.current = loadNext;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !active || !online || !hasNext || loading || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      {
        root: node.closest(".mobile-drawer-scroll"),
        rootMargin: "0px 0px 180px 0px",
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, online, hasNext, loading, error]);
  return (
    <div className="symbol-search-panel">
      <div className="symbol-search-controls">
        <InputGroup className="data-search-input">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label={label}
            placeholder={placeholder}
            value={query}
            maxLength={maxLength}
            onChange={(e) => onQuery(e.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="清空搜索"
                onClick={() => onQuery("")}
              >
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        {enhancedFilters}
      </div>
      {filters}
      {note}
      {loading && !loaded && <DataLoading label="正在读取品种…" />}
      {children}
      <div ref={sentinel} className="symbol-search-footer" aria-live="polite">
        {error ? (
          <>
            <span>{error}</span>
            <Button
              variant="ghost"
              disabled={!online || loading}
              onClick={retry}
            >
              重试
            </Button>
          </>
        ) : !online ? (
          <span>离线 · 联网后继续读取</span>
        ) : loading && loaded ? (
          <span>正在加载…</span>
        ) : loaded && !hasNext ? (
          <span>已显示全部</span>
        ) : null}
      </div>
      {!loaded && !loading && !error && !online && (
        <DataEmpty title="暂无本地数据">联网后可搜索品种。</DataEmpty>
      )}
    </div>
  );
}

/** One result geometry, with the entry intent supplying its single primary action. */
export function SymbolSearchRow({
  children,
  action,
  onSelect,
  disabled,
  catalog = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  catalog?: boolean;
}) {
  return (
    <div className="symbol-search-row">
      <Button
        variant="plain"
        className={
          catalog ? "symbol-search-body data-catalog-row" : "symbol-search-body"
        }
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="symbol-result-identity">{children}</span>
        {!action && <ChevronRight aria-hidden="true" />}
      </Button>
      {action}
    </div>
  );
}
