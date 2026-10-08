import { Link } from "./router";
import { OpenChart } from "./OpenChart";
import { useSnapshot } from "./useSnapshot";
import { Feedback } from "./Center";
import { names, time } from "./types";

type Summary = {
  id: string; start: number; end: number; published_at: number | null;
  payload_available: boolean; parent_version_id: string | null;
  refresh_start: number | null; refresh_end: number | null;
  manifest: {rows?: number; unknown_minutes?: number; checksum?: string};
  periods: {timeframe: string; status: string; rows: number}[];
};
type Comparison = {
  current: Summary; previous: Summary | null; meaning: string;
  differences?: {observed_minutes_delta: number; unknown_minutes_delta: number;
    same_original_checksum: boolean; unchanged_same_window_chunks: number;
    changed_same_window_chunks: number; nonmatching_partition_chunks: number};
};

export function VersionComparison({version, refresh}: {version: string; refresh: number}) {
  const result = useSnapshot<Comparison>(`/market-data/versions/${version}/comparison`, refresh);
  const data = result.data;
  return <section aria-label="固定历史发布差异" className="dc-fields">
    <h2>与前版差异</h2>
    <Feedback error={result.error} loading={result.loading} empty={!data}/>
    {data && <>
      <p>{data.meaning}</p>
      {!data.previous && <p>该版本没有前一已发布版本。</p>}
      <div className="dc-table"><table>
        <caption>固定版本发布清单</caption>
        <thead><tr><th>版本</th><th>发布时间与范围</th><th>观测 / 未知分钟</th><th>周期与操作</th></tr></thead>
        <tbody>{[data.current, data.previous].filter((v): v is Summary => !!v).map((v, i) => <tr key={v.id}>
          <td>{i === 0 ? "当前选择" : "前一发布"}<span>{v.id}</span></td>
          <td>{time(v.published_at)}<span>{time(v.start)} 至 {time(v.end)}</span></td>
          <td>{v.manifest.rows ?? "—"} / {v.manifest.unknown_minutes ?? "—"}</td>
          <td>{v.periods.map(p => `${p.timeframe} · ${names[p.status] || p.status} (${p.rows})`).join("； ")}
            {v.payload_available ? <span><OpenChart ticker={`MWH:${v.id}`} label="打开此版本" /> · <Link to={`/replay?dataset_version=${v.id}`}>用于回测</Link></span> : <span>价格已回收，仅保留清单</span>}
          </td>
        </tr>)}</tbody>
      </table></div>
      {data.differences && <dl className="dc-facts">
        <div><dt>观测分钟变化</dt><dd>{data.differences.observed_minutes_delta}</dd></div>
        <div><dt>未知分钟变化</dt><dd>{data.differences.unknown_minutes_delta}</dd></div>
        <div><dt>原始清单校验和</dt><dd>{data.differences.same_original_checksum ? "相同" : "不同"}</dd></div>
        <div><dt>同区间分块</dt><dd>{data.differences.unchanged_same_window_chunks} 未变化；{data.differences.changed_same_window_chunks} 校验和变化；{data.differences.nonmatching_partition_chunks} 个新分区不可直接比较</dd></div>
      </dl>}
      {data.current.refresh_start !== null && <p>本次复查范围：{time(data.current.refresh_start)} 至 {time(data.current.refresh_end)}。旧发布与已保存引用保持固定。</p>}
    </>}
  </section>;
}
