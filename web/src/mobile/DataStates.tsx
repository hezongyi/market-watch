import type { ReactNode } from "react";
import { SearchX, WifiOff } from "lucide-react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty";
import { Skeleton } from "./components/ui/skeleton";

export function DataEmpty({
  title,
  children,
  action,
  offline = false,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  offline?: boolean;
}) {
  const Icon = offline ? WifiOff : SearchX;
  return (
    <Empty className="data-empty" role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function DataLoading({
  label = "正在读取…",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="data-loading" role="status" aria-label={label}>
      <p className="mobile-rows-note">{label}</p>
      <div aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div className="data-skeleton-row" key={i}>
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        ))}
      </div>
    </div>
  );
}
