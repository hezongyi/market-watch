import type { ReactNode } from "react";
import { CandlestickChart, WifiOff } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./components/ui/empty";

export function ChartEmpty({
  title,
  children,
  offline,
  action,
}: {
  title: string;
  children?: ReactNode;
  offline?: boolean;
  action?: ReactNode;
}) {
  const Icon = offline ? WifiOff : CandlestickChart;
  return (
    <section
      className="mobile-chart mobile-controls chart-idle"
      aria-label="图表"
    >
      <header className="chart-idle-header">
        <h1>图表</h1>
      </header>
      <Empty className="chart-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle><h2>{title}</h2></EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
        {action && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </section>
  );
}
