"""Publish supplemental findings only after raw artifact validation."""
import json
from pathlib import Path

from audit_supplemental import audit

HERE=Path(__file__).resolve().parent
ROOT=HERE/'results'/'supplemental'


def host(label):
    rows=[json.loads(line) for line in (ROOT/'host.jsonl').read_text().splitlines()]
    rows=[r for r in rows if r['label']==label and 'proc_stat' in r]
    assert len(rows)>1
    def cpu(row):return list(map(int,row['proc_stat'].splitlines()[0].split()[1:9]))
    delta=[b-a for a,b in zip(cpu(rows[0]),cpu(rows[-1]))]
    vm=lambda row:{k:int(v) for k,v in (line.split() for line in row['vmstat'].splitlines())}
    a,z=vm(rows[0]),vm(rows[-1])
    return dict(samples=len(rows),busy_percent=100*(sum(delta)-delta[3]-delta[4])/sum(delta),
        steal_percent=100*delta[7]/sum(delta),swap_in=z['pswpin']-a['pswpin'],
        swap_out=z['pswpout']-a['pswpout'])


def main():
    reports=audit()
    rows={label:json.loads((ROOT/(label+'.json')).read_text()) for label in reports}
    hosts={label:host(label) for label in reports}
    (ROOT/'artifact-audit.json').write_text(json.dumps(dict(passed=True,runs=reports,host=hosts),indent=2)+'\n')
    lines=['# P0 补充验证：时钟、完整快照与混合负载','',
        'Ubuntu quant-server，独立project `mw-issue13-p0`、PG14 `issue13`；源码基线`0591e56`，本地告警小修复提交`d362766`。两个场景各300秒，串行reset固定fixture；原12份基线未覆盖。单份补测不替代三重复基线或优化验收。', '',
        '时钟为fixture epoch加实际monotonic经过毫秒，不随事件数量跳跃。mixed等新分钟完整结束且五秒确认余量经过后再提交；ingest参数与observed_at不晚于worker时钟，但bar_batch内部received_at仍来自系统wall clock（该模块按值导入now_ms）。因此仅证明观察时间输入顺序，不是全部摄入时钟一致性或新鲜度SLA。十身份各一个连续新分钟和一个同价观察，后者作用于原末分钟，避免覆盖尚未可见的新bar预期。两个身份同时将历史计划扩大至fixture起点。仍是合成来源，不证明供应商确认或完整应用SLA。','',
        '| 场景 | 轮数 | 进程CPU（单核） | worker SQL/s | 最长目标等待 | 宿主忙碌率 | 可见 / 输入 |',
        '| --- | --- | --- | --- | --- | --- | --- |']
    for label,row in rows.items():
        h=hosts[label]
        lines.append(f"| {label} | {row['cycles']} | {row['process_cpu_percent']:.2f}% | {row['worker_sql_per_second']:.2f} | {row['longest_target_wait']:.2f}s | {h['busy_percent']:.2f}% | {len(row['events'])}/{len(row['events'])+len(row['unpublished_events'])} |")
    idle,mixed=rows['idle'],rows['mixed']
    lines+=['',f"空闲前后完整bar指纹相等：`{idle['before']['sha256']}`；涵盖{sum(idle['before']['counts'].values()):,}行所有持久字段（含payload与行revision）。可见publication元信息相等，但{idle['publications_timestamp_changed']}个updated_at变化，worker计到{idle['queries'].get('publication_updates',0)}条publication UPDATE。该场景证明持续时钟下仍有空闲读写；没有输入且队列均空。",'',
        'CPU口径包含worker、输入、M1验证及锁采样线程；最终完整指纹读取排除在300秒计时外。worker SQL计数只含主线程worker scope；PG统计包含reset后验证与锁采样。宿主竞争、限流、swap原始记录保留；CPU更高可由调度机会与循环次数造成，不能当成收益或回退。','',
        '| 身份 | 新分钟可见 / 输入 | 同价观察可见 / 输入 | 未可见 |',
        '| --- | --- | --- | --- |']
    for ident in mixed['inputs_by_identity']:
        done=[e for e in mixed['events'] if e['instrument']==ident]
        pending=[e for e in mixed['unpublished_events'] if e['instrument']==ident]
        lines.append(f"| {ident} | {sum(e['kind']=='new_bar' for e in done)}/1 | {sum(e['kind']=='observation' for e in done)}/1 | {len(pending)} |")
    q=mixed['latency_completed_only']
    if q['p95'] is not None:
        lines+=['',f"完成事件提交→published M1完整payload匹配：nearest-rank p50/p95/p99 {q['p50']:.3f}/{q['p95']:.3f}/{q['p99']:.3f}s。最后30秒之前已提交仍未可见{mixed['unpublished_before_final30s']}项；其余未可见也保留分母。源M1字段直接构造预期，未从published read_rows反向定义期望；高周期OHLC/volume/complete全量正确性仍未证明。"]
    lines+=['', '锁采样通过独立连接每500ms查询pg_stat_activity及blocking_pids；没有额外外部持锁者。', '',
        '| 场景 | 锁采样数 | 出现Lock等待的样本 | 宿主swap in/out页 |',
        '| --- | --- | --- | --- |']
    for label,row in rows.items():
        lines.append(f"| {label} | {row['lock_sample_count']} | {row['lock_wait_samples']} | {hosts[label]['swap_in']}/{hosts[label]['swap_out']} |")
    lines+=['', '零Lock样本不能排除短于采样间隔的等待；这不是外部写入锁争用实验。目标选择只是现有轮转观测，不证明新调度公平性。mixed新增bar含高周期，未按独立历史/实时吞吐分类，不能用总行数宣称历史完全补齐。', '',
        '原始证据：[idle](results/supplemental/idle.json)、[mixed](results/supplemental/mixed.json)、逐轮JSONL、各场景SQL与locks JSON、[宿主](results/supplemental/host.jsonl)、[artifact审核](results/supplemental/artifact-audit.json)。重跑命令 `python3 docs/verification/issue-13/run_supplemental.py`，已有输出拒绝覆盖；审核 `python3 docs/verification/issue-13/audit_supplemental.py`。PG地址`127.0.0.1:19613`；启动/停止见[README](README.md)。', '',
        'P1–P3继续等待三层合并。真实网络API/告警并发另测；完整网页/浏览器、provider lifespan、持久世代、迁移/回退仍未验收。']
    (HERE/'supplemental-report.md').write_text('\n'.join(lines)+'\n')


if __name__=='__main__':main()
