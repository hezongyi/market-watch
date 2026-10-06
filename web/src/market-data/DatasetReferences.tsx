import { useRef, useState } from "react";
import { api } from "../api";
import { Feedback } from "./Center";
import { useSnapshot } from "./useSnapshot";

type ReferenceReport = {
  items: { kind: string; id: string; detail: string }[];
  can_reclaim: boolean;
  requires_archive: boolean;
  retains: string;
};

export function DatasetReferences({
  id,
  refresh,
  onDone,
}: {
  id: string;
  refresh: number;
  onDone: () => void;
}) {
  const report = useSnapshot<ReferenceReport>(
    `/market-data/datasets/${id}/references`,
    refresh,
  );
  const [review, setReview] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [result, setResult] = useState<any>(null);
  const request = useRef(crypto.randomUUID());
  async function reclaim() {
    setBusy(true);
    setError("");
    try {
      const response = await api(`/market-data/datasets/${id}/reclaim`, {
        request_id: request.current,
      });
      setResult(response);
      setReview(false);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dc-fields">
      <h2>引用与历史回收</h2>
      <Feedback
        error={report.error}
        loading={report.loading}
        empty={!report.data}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {report.data && (
        <>
          <p>实时映射与组合入口正在接入；查看引用不会建立实时需求。</p>
          {report.data.items.length > 0 ? (
            <div className="dc-table">
              <table>
                <caption>阻止历史回收的引用与任务</caption>
                <thead>
                  <tr>
                    <th>依赖</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((item, i) => (
                    <tr key={`${item.kind}:${item.id}:${i}`}>
                      <td>{item.detail}</td>
                      <td>
                        {item.kind === "replay" ? (
                          <a href="/replay">查看历史演练</a>
                        ) : item.kind === "task" ? (
                          <a href={`/market-data?tab=tasks&dataset_id=${id}`}>
                            查看任务
                          </a>
                        ) : (
                          "保留引用，禁止回收"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>当前未发现阻止回收的引用。</p>
          )}
          {report.data.requires_archive && (
            <p>回收前请先在维护设置中暂停定时维护并归档。</p>
          )}
          <p>
            {report.data.retains}。共享来源缓存和其他数据集仍引用的分块保留。
          </p>
          {!review ? (
            <button
              disabled={busy || !report.data.can_reclaim}
              onClick={() => setReview(true)}
            >
              查看回收影响
            </button>
          ) : (
            <div className="panel" aria-label="确认历史回收">
              <p>
                回收此数据集全部无引用历史价格及周期产物。此操作不能撤销；原版本仅保留身份和发布清单，不能再用于图表或回测。以后重新维护会产生新版本。
              </p>
              <div className="dc-actions">
                <button
                  disabled={busy || !report.data.can_reclaim}
                  onClick={() => void reclaim()}
                >
                  回收无引用历史价格
                </button>
                <button disabled={busy} onClick={() => setReview(false)}>
                  取消回收
                </button>
              </div>
            </div>
          )}
          {result && (
            <p role="status">
              已回收 {result.versions}{" "}
              个版本的价格数据。身份和发布清单保留；数据库空间可供后续写入复用。
            </p>
          )}
        </>
      )}
    </div>
  );
}
