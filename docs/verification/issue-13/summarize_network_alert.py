"""Check actual TCP/alert results and write the scoped baseline report."""
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results'


def main():
    row=json.loads((ROOT/'network-alert'/'result.json').read_text())
    assert row['duration']>=120 and not row['errors']
    assert row['api']['count']==len(row['api_samples'])==120
    assert row['inputs']==row['visible']==row['judged']==len(row['events'])==10
    assert len({e['instrument'] for e in row['events']})==10
    assert all(e['final']['signal_count']==e['final']['count']==1 for e in row['events'])
    assert all(e['source_observed_at']<=e['source_received_at'] for e in row['events'])
    assert all(e['source_observed_at']>=e['expected_end']+5000 for e in row['events'])
    assert all(e['visibility']['at']>=e['committed_seconds'] for e in row['events'])
    assert (ROOT/'network-alert-host-access.txt').exists()
    assert all(row['queries'].get(scope+'_'+label,0)==0 for scope in ('alert',)
        for label in ('staging_reads','audit_reads'))
    api=row['api']
    judgment=row['alert_latency_completed_only']
    cpu_samples=[json.loads(line) for line in (ROOT/'network-alert-host.jsonl').read_text().splitlines()]
    cpu_samples=[r for r in cpu_samples if 'proc_stat' in r]
    assert len(cpu_samples)>1
    cpu=lambda r:list(map(int,r['proc_stat'].splitlines()[0].split()[1:9]))
    delta=[b-a for a,b in zip(cpu(cpu_samples[0]),cpu(cpu_samples[-1]))]
    busy=100*(sum(delta)-delta[3]-delta[4])/sum(delta)
    lines=['# P0 TCP API 与发布告警并发基线','',
        'Ubuntu quant-server，独立Compose project `mw-issue13-p0`、PG14 `issue13`；本地`d362766`告警小修复，主线基线`0591e56`。真实Uvicorn、认证路由、序列化、PG、发布循环与每秒真实chart_alert_worker.step并发；120秒测量，十个新分钟。三层核心改造仍等待合并。','',
        f"运行中实际地址`127.0.0.1:19614`，Ubuntu宿主已检查protected API返回401；120次认证数据请求由同容器TCP客户端发出。探针结束已移除服务，PG由runner停止，地址不保持在线。进程CPU {row['process_cpu_percent']:.2f}%（单核），宿主采样忙碌率{busy:.2f}%；CPU含API、客户端、发布、告警与可见性观察，不直接与纯worker对照。",'',
        '| 范围 | 样本 | nearest-rank p50 | p95 | p99 |',
        '| --- | --- | --- | --- | --- |',
        f"| TCP published API：10身份×M1/M30/W1/MN×3 | 120 | {api['p50']*1000:.2f}ms | {api['p95']*1000:.2f}ms | {api['p99']*1000:.2f}ms |",
        f"| published M1被观察到→告警step提交被观察到 | 10 | {judgment['p50']*1000:.2f}ms | {judgment['p95']*1000:.2f}ms | {judgment['p99']*1000:.2f}ms |",'',
        'API均返回非空bar（≤500），未检查所有正在变化payload的全量独立正确性。十身份均有价格由阈值下方向上穿越的新完成分钟，十个signal已创建（consume同事务创建本地notification，本次未独立记录通知计数）；至测量结束各count和signal_count仍为1，允许2次触发所以重复会被检测。未启动外部通知投递。','',
        '| 身份 | 提交→观察到发布 | 观察到发布→观察到判断 | 判断延迟估计上界 | signal/count |',
        '| --- | --- | --- | --- | --- |']
    for e in row['events']:
        lines.append(f"| {e['instrument']} | {e['commit_to_visible']:.3f}s | {e['visible_to_judged']:.3f}s | {e['visible_to_judged_upper']:.3f}s | {e['final']['signal_count']}/{e['final']['count']} |")
    lines+=['', '可见性每50ms查询，判断时间来自step结束后读到count，均为提交后观测时刻。估计上界加入查询起点和50ms轮询间隔，但线程调度/前一轮查询耗时可能增加误差，不是精确提交到提交时延；十样本nearest-rank p95/p99等于最大值。保留全部输入分母，没有隐藏未可见或未判断项。','',
        '输入前统一写入/聚合/发布模块按值导入的now_ms；fixture epoch加实际monotonic经过时间，不按事件数推进。实际源received_at和observed_at已保存并断言不晚于消费者时钟，完成分钟已经结束且五秒余量已经过。告警基准和新输入为同一时钟。早期补充mixed的内部received_at wall clock限制不沿用于本探针。','',
        f"已正确归因的告警查询计数：`{json.dumps({k:v for k,v in row['queries'].items() if k.startswith('alert_')},sort_keys=True)}`，零staging/审计读。当前API计数仅覆盖AnyIO认证依赖线程（120 SQL），异步路由数据读在Uvicorn线程被归入verification，故本次不能单独证明API零staging/审计或总SQL。先前ASGI微基线另有准确scope证据。后续脚本已修正线程归因，原结果保留不重写；执行版脚本按已知改动逆向还原保存，非运行前捕获哈希，见source-provenance.json；publisher仍有这些读写，告警零读取不代表整体空闲优化达标。",'',
        '本探针关闭API lifespan：没有provider prewarm、供应商采集、native MCP transport、完整网页/浏览器。它只补实际TCP消费与十个M1触发的短并发窗口，不证明全应用常驻CPU、浏览器预算、持续正常输入SLA、同价盘中新鲜度或高周期触发/防重。网络候选门槛可在此合成范围对照，但完整应用验收仍未完成。','',
        '运行：`python3 docs/verification/issue-13/run_network_alert.py`，已有证据拒绝覆盖。PG启动/停止与凭据管理见[README](README.md)，只操作本任务project。原始：[result.json](results/network-alert/result.json)、[宿主采样](results/network-alert-host.jsonl)、[主机地址检查](results/network-alert-host-access.txt)。完整线程逐轮时长、原始API样本、可见payload、源时间与cgroup限流均保留。']
    (HERE/'network-alert-report.md').write_text('\n'.join(lines)+'\n')
    (ROOT/'network-alert'/'artifact-audit.json').write_text(json.dumps(dict(passed=True,
        api_samples=120,input_denominator=10,visible=10,judged=10,unique_signals=10,
        host_samples=len(cpu_samples),host_busy_percent=busy),indent=2)+'\n')
    print('Network/alert artifact audit passed: 120 TCP reads, 10 inputs, 10 visible, 10 judged, 10 unique signals')


if __name__=='__main__':main()
