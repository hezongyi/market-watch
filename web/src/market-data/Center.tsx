import { Tasks } from "./Tasks";
import { useLocation, useSearchParams } from "./router";
import { api } from "./api";
import { DatasetDetail } from "./DatasetDetail";
import { DatasetCreate } from "./DatasetCreate";
import { CompositeDetail, CompositeList, MappingForm } from "./Composites";
import { names } from "./types";
import { useSnapshot } from "./useSnapshot";
import { NativeConfigure } from "./NativeConfigure";
import { PlatformMarket } from "./PlatformMarket";
import { ManagedMarket } from "./ManagedMarket";

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
export function Sources() {
  const result = useSnapshot<any[]>("/market-data/sources");
  return (
    <section className="data-center">
      <h1>来源与能力</h1>
      <p>已接入能力与实际连接健康分别判断；此处不推测连接状态。</p>
      <Feedback
        error={result.error}
        loading={result.loading}
        empty={!result.data}
      />
      {result.data?.map((s) => (
        <div className="dc-source" key={s.source}>
          <h2>{names[s.source] || s.source}</h2>
          <p>原生周期：{s.native_periods.join("、") || "尚未接入"}</p>
          <p>
            M1 历史：{s.history_m1 ? "支持" : "未开放"}；实时流：
            {s.stream ? "支持" : "未开放"}
          </p>
        </div>
      ))}
      <p>
        OANDA Practice
        连接由管理员在部署配置中维护。授权异常时核对账户环境与访问授权，更新连接后重试失败范围。此处不显示账户或密钥。
      </p>
    </section>
  );
}
export default function Center() {
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
  if (params.get("tab") === "sources") return <Sources />;
  if (params.get("tab") === "platform") return <PlatformMarket />;
  if ((params.get("tab") || "managed") === "managed") return <ManagedMarket />;
  if (params.get("tab") === "composite") return <CompositeList />;
  return <Tasks />;
}
