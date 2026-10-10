import { Tasks } from "./Tasks";
import { useLocation, useSearchParams } from "./router";
import { DatasetDetail } from "./DatasetDetail";
import { DatasetCreate } from "./DatasetCreate";
import { CompositeDetail, CompositeList, MappingForm } from "./Composites";
import { NativeConfigure } from "./NativeConfigure";
import { PlatformMarket } from "./PlatformMarket";
import { ManagedMarket } from "./ManagedMarket";
import { LiveProviderStatus } from "./LiveProviderStatus";

export function Feedback({
  error,
  loading,
  empty,
}: {
  error: string;
  loading: boolean;
  empty: boolean;
}) {
  if (error)
    return (
      <p role="alert" className="error">
        {error}。稍后自动重试；已有结果保留。
      </p>
    );
  if (loading && empty) return <p role="status">正在读取数据…</p>;
  return null;
}
export function Pager({
  total,
  page,
  size,
  change,
}: {
  total: number;
  page: number;
  size: number;
  change: (p: number) => void;
}) {
  return (
    <nav className="dc-actions" aria-label="列表分页">
      <span>
        共 {total} 条 · 第 {page} 页
      </span>
      <button disabled={page <= 1} onClick={() => change(page - 1)}>
        上一页
      </button>
      <button disabled={page * size >= total} onClick={() => change(page + 1)}>
        下一页
      </button>
    </nav>
  );
}
export { TaskActions } from "./Tasks";
function CenterPage() {
  const { pathname } = useLocation(),
    [params] = useSearchParams();
  if (pathname === "/market-data/platform/configure")
    return <NativeConfigure key={params.get("instrument")} />;
  if (pathname === "/market-data/datasets/new") return <DatasetCreate />;
  if (pathname.endsWith("/mapping")) return <MappingForm key={pathname} />;
  if (pathname.includes("/datasets/"))
    return <DatasetDetail key={pathname + ":" + params.get("section")} />;
  if (pathname.includes("/composites/"))
    return <CompositeDetail key={pathname} />;
  if (params.get("tab") === "platform") return <PlatformMarket />;
  if ((params.get("tab") || "managed") === "managed") return <ManagedMarket />;
  if (params.get("tab") === "composite") return <CompositeList />;
  if (params.get("tab") === "tasks") return <Tasks />;
  if (params.get("tab") === "sources") return <LiveProviderStatus />;
  return <ManagedMarket />;
}

export default function Center() {
  return <CenterPage />;
}
