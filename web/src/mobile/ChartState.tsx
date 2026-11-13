import type { ReactNode } from "react";
import { ChartNoAxesCombined, WifiOff } from "lucide-react";
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
  const Icon = offline ? WifiOff : ChartNoAxesCombined;
  return (
    <section
      className="mobile-chart mobile-controls chart-idle"
      aria-label="图表"
    >
      <h1>图表</h1>
      <Empty role="status" className="chart-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
        {action && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </section>
  );
}
