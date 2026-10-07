"""Summarize only completed baseline files; fail if any required run is missing."""
import json
import statistics
from pathlib import Path

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results'


def read(name):
    return json.loads((ROOT/name).read_text())


def pairs(value):
    return {line.split()[0]:int(line.split()[1]) for line in value.splitlines() if len(line.split())==2}


def host_summary():
    samples=[json.loads(line) for line in (ROOT/'suite-host.jsonl').read_text().splitlines()]
    output={}
    for label in sorted({s['label'] for s in samples if '-reset' not in s['label']}):
        rows=[s for s in samples if s['label']==label and 'proc_stat' in s]
        if len(rows)<2:
            output[label]={'insufficient_samples':True}
            continue
        def cpu(row):
            fields=next(line.split()[1:] for line in row['proc_stat'].splitlines() if line.startswith('cpu '))
            # guest/guest_nice are already included in user/nice.
            return list(map(int,fields[:8]))
        delta=[b-a for a,b in zip(cpu(rows[0]),cpu(rows[-1]))]
        total=sum(delta)
        vm_before,vm_after=pairs(rows[0]['vmstat']),pairs(rows[-1]['vmstat'])
        db_cpu=[float(c['CPUPerc'].rstrip('%')) for r in rows for c in r['containers'] if c['Name']=='mw-issue13-p0-postgres-1']
        output[label]=dict(samples=len(rows),load_mean=[statistics.mean(r['load'][i] for r in rows) for i in range(3)],
            host_busy_percent=100*(total-delta[3]-delta[4])/total if total else None,
            iowait_percent=100*delta[4]/total if total else None,steal_percent=100*delta[7]/total if total else None,
            swap_in_pages=vm_after.get('pswpin',0)-vm_before.get('pswpin',0),
            swap_out_pages=vm_after.get('pswpout',0)-vm_before.get('pswpout',0),
            db_docker_cpu_mean=statistics.mean(db_cpu) if db_cpu else None,
            minimum_disk_free=min(r['disk_free'] for r in rows),
            limitations='Host interval covers sampled boundaries only; database Docker CPU is sampled, not continuous')
    return output


def main():
    log=(ROOT/'suite.log').read_text()
    if 'SUITE COMPLETE' not in log:
        raise SystemExit('Suite not complete; do not publish a partial baseline as completed')
    from audit_measurements import audit
    audits=[audit(scenario,rep) for scenario in ('idle','live','backfill','revision') for rep in range(1,4)]
    (ROOT/'measurement-audit.json').write_text(json.dumps(dict(complete=True,runs=audits,missing=[]),indent=2)+'\n')
    runs=[]
    for scenario in ('idle','live','backfill','revision'):
        for repetition in range(1,4):
            row=read(f'{scenario}-{repetition}.json')
            assert row['duration']>=300 and row['cycles']>0
            assert (ROOT/f'{scenario}-{repetition}-sql.json').exists()
            sql=read(f'{scenario}-{repetition}-sql.json')['statements']
            row['pg_source_returned_rows']=sum(q['rows'] for q in sql if 'FROM candles' in q['query'])
            row['pg_source_exec_ms']=sum(q['total_exec_time'] for q in sql if 'FROM candles' in q['query'])
            row['pg_audit_exec_ms']=sum(q['total_exec_time'] for q in sql if 'FROM audit_events' in q['query'])
            runs.append(row)
    host=host_summary()
    (ROOT/'host-summary.json').write_text(json.dumps(host,indent=2)+'\n')
    lines=['# P0 PostgreSQL 四场景性能基线','',
        'Ubuntu quant-server，本任务独立 PG14 / schema main `0591e56`，10 个合成身份；每场景300秒、重复3次、相同快照重置，预热后的热缓存样本。0号短测排除。',
        '', '| 场景 | CPU 均值（单核百分比） | worker SQL/s 均值 | 审计读/s 均值 | 每轮p95范围 | 最长目标间隔 | 已可见 / 输入事件 | 未可见 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |']
    summaries={}
    for scenario in ('idle','live','backfill','revision'):
        group=[r for r in runs if r['scenario']==scenario]
        cpu=statistics.mean(r['process_cpu_percent'] for r in group)
        sql=statistics.mean(r['queries']['total']/r['duration'] for r in group)
        audit=statistics.mean(r['queries'].get('audit_reads',0)/r['duration'] for r in group)
        wait=max(r['longest_target_wait'] for r in group)
        complete=sum(len(r['events']) for r in group)
        pending=sum(len(r['unpublished_events']) for r in group)
        times=[r['cycle_p95'] for r in group]
        summaries[scenario]=dict(cpu_percent=cpu,sql_per_second=sql,audit_reads_per_second=audit,
            max_target_wait=wait,published_events=complete,unpublished_events=pending,
            backfill_bars_per_second=statistics.mean(r['backfill_bars_per_second'] for r in group))
        lines.append(f'| {scenario} | {cpu:.2f}% | {sql:.2f} | {audit:.2f} | {min(times):.3f}–{max(times):.3f}s | {wait:.2f}s | {complete}/{complete+pending} | {pending} |')
    lines += ['', '## 事件分母与观测截尾', '',
        '| 样本 / 输入类别 | 输入 | 已可见 | 截止前30秒已提交但仍未可见 | 最后30秒仍未可见 | 已完成事件p95 |',
        '| --- | --- | --- | --- | --- | --- |']
    event_summary=[]
    for row in runs:
        for kind in sorted({e['kind'] for e in row['events']+row['unpublished_events']}):
            finished=[e for e in row['events'] if e['kind']==kind]
            pending=[e for e in row['unpublished_events'] if e['kind']==kind]
            overdue=sum(e['committed_seconds']<=row['duration']-30 for e in pending)
            latencies=sorted(e['latency_seconds'] for e in finished)
            p95=latencies[int((len(latencies)-1)*.95)] if latencies else None
            label=f"{row['scenario']}-{row['repetition']} / {kind}"
            value=f'{p95:.3f}s' if p95 is not None else '无完成样本'
            lines.append(f'| {label} | {len(finished)+len(pending)} | {len(finished)} | {overdue} | {len(pending)-overdue} | {value} |')
            event_summary.append(dict(run=f"{row['scenario']}-{row['repetition']}",kind=kind,
                inputs=len(finished)+len(pending),published=len(finished),unpublished_older_than_30s=overdue,
                unpublished_final30s=len(pending)-overdue,completed_only_p95=p95))
    (ROOT/'event-summary.json').write_text(json.dumps(event_summary,indent=2)+'\n')
    lines += ['', '进程 CPU 含 worker、输入和验证；SQL计数仅含 worker，PG统计包含所有探针SQL。未可见事件是观测截止时仍未匹配，完整分母保留；只对完成事件计算分位数会产生截尾偏差，不能据此判通过。事件详情和三次各自 p50/p95/p99 见各结果 JSON。',
        '', '## PostgreSQL 源读取', '',
        '| 样本 | 源SELECT返回行数 | 源SELECT累计执行时间 | 审计SELECT累计执行时间 |',
        '| --- | --- | --- | --- |']
    for row in runs:
        lines.append(f"| {row['scenario']}-{row['repetition']} | {row['pg_source_returned_rows']} | {row['pg_source_exec_ms']/1000:.3f}s | {row['pg_audit_exec_ms']/1000:.3f}s |")
    lines += ['', 'PG统计的源SELECT包含注入事件读取，记录的是返回行数而非扫描行数；扫描细节仅由独立EXPLAIN案例提供，不能混称。',
        '', '虚拟输入时钟每事件推进60秒，实际输入在上一事件完成10秒后提交；新bar received_at为worker虚拟时钟+65秒。延迟是monotonic提交到匹配published M1，不是源确认或告警新鲜度SLA。每身份固定接受新分钟或同价观察之一，两种输入的身份交叉覆盖未完成。',
        '', '无 API、告警、网页/浏览器或真实供应商进程。本报告不证明这些消费者延迟、生产 CPU、三层性能或完整正确性。单独 backfill 不证明实时与回填并存公平性。',
        '', '宿主竞争与限流逐样本见 [results/suite-host.jsonl](results/suite-host.jsonl) 和各测量 cgroup_before/after。开跑前 CPU 接近满载；所有时间测量先标记竞争污染，必须在可比较竞争条件下复测后用于容量结论。swap已占满不等于测量期间发生换页。',
        '', '覆盖案例与执行计划见 [results/coverage.json](results/coverage.json)。未知旧审计记录的迁移等价性仍未证明；不能使用合成区间差集直接授权生产读取切换。',
        '', '## 宿主竞争、数据库 CPU 和限流', '',
        '| 样本 | 宿主忙碌率 | DB Docker CPU均值 | swap in/out页 | probe限流次数 / 时间 |',
        '| --- | --- | --- | --- | --- |']
    for row in runs:
        label=f"{row['scenario']}-{row['repetition']}"
        observed=host.get(label,{})
        a=pairs(row.get('cgroup_before',{}).get('cpu.stat',''))
        b=pairs(row.get('cgroup_after',{}).get('cpu.stat',''))
        count=b.get('nr_throttled',0)-a.get('nr_throttled',0)
        elapsed=(b.get('throttled_usec',0)-a.get('throttled_usec',0))/1e6
        def fmt(value): return f'{value:.2f}%' if value is not None else '未采到'
        lines.append(f"| {label} | {fmt(observed.get('host_busy_percent'))} | {fmt(observed.get('db_docker_cpu_mean'))} | {observed.get('swap_in_pages','?')}/{observed.get('swap_out_pages','?')} | {count} / {elapsed:.3f}s |")
    lines += ['', '限流时间是cgroup调度统计，不等于应用延迟增量。数据库CPU有采样盲区；全部宿主边界、load、steal/iowait、磁盘余量和原始分母见 [results/host-summary.json](results/host-summary.json)。',
        '', '## 核心优化前数值门槛依据', '',
        '以下为四场景基线导出的数值依据；冻结的完整口径及消费者门槛见 [acceptance-thresholds.md](acceptance-thresholds.md)。当前尚未优化或达标；宿主竞争必须复测，核心优化后的目标不能按结果放宽。',
        '', '| 指标 | 候选数值门槛 | 依据 / 仍需证据 |', '| --- | --- | --- |']
    idle=summaries['idle']
    backfill=summaries['backfill']
    lines += [f"| 空闲worker进程CPU | ≤5%且相对基线降低≥80%；本轮参照 {idle['cpu_percent']:.2f}% | 同配额、相同固定输入和可比较宿主竞争下对照 |",
        f"| 空闲worker SQL | ≤2/s且降低≥90%；本轮参照 {idle['sql_per_second']:.2f}/s | 排除明确标记的低频核对；正常路径审计读=0，无历史重算/发布写入 |",
        '| M1提交到发布可见 | p95≤15s、p99≤30s；未可见分母=0（排除独立报告的最后30s截尾窗口） | 不以减少发布数据或丢修订达成；同价观察也必须满足 |',
        '| 可运行目标最长等待 | ≤10s；等待/失败目标独立报告最早到期和重试原因 | 10身份90周期及混合实时/回填，不依靠空目标忙转 |',
        f"| 回填吞吐 | ≥{max(0,backfill['backfill_bars_per_second']*.8):.2f} published bars/s（基线均值80%） | 同一fixture/竞争/配额，另测实时并发；若样本污染需先重新冻结基线 |",
        '| API/告警延迟 | 服务时间和网络/判断目标详见冻结门槛；未测项不能判通过 | 进程内ASGI/PG微基线已另测；网络API/后台线程/浏览器和输入到告警仍待完整验收 |',
        '| 本任务资源预算 | PG≤0.75CPU/512MiB、probe≤0.75CPU/768MiB；单次测量串行 | 后续完整应用/浏览器总预算需重新实测；不能套用于生产或VM |',
        '', '核心修复仍等待三层 PR 合并。版本矩阵、回归矩阵和停止命令见 [README](README.md)。']
    (HERE/'pg-baseline-report.md').write_text('\n'.join(lines)+'\n')
    (ROOT/'summary.json').write_text(json.dumps(summaries,indent=2)+'\n')
    print('12 completed measurements summarized; limitations and pending gates retained')


if __name__=='__main__': main()
