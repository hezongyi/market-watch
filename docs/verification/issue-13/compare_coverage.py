"""Compare exported effective intervals locally; never access a database or migrate."""
import json
import gzip
from collections import Counter
from pathlib import Path

HERE=Path(__file__).resolve().parent
MINUTE=60000


def merged(spans):
    result=[]
    for a,b in sorted(spans):
        if b<=a: continue
        if result and a<=result[-1][1]: result[-1][1]=max(result[-1][1],b)
        else: result.append([a,b])
    return result


def subtract(left,right):
    # Linear sweep over sorted disjoint intervals, preserving every unknown gap.
    result=[]
    index=0
    for a,b in left:
        cursor=a
        while index<len(right) and right[index][1]<=a: index+=1
        j=index
        while j<len(right) and right[j][0]<b:
            x,y=right[j]
            if x>cursor: result.append([cursor,min(x,b)])
            cursor=max(cursor,y)
            if cursor>=b: break
            j+=1
        if cursor<b: result.append([cursor,b])
    return result


def minute(a,b):
    if isinstance(a,bool) or isinstance(b,bool) or not isinstance(a,int) or not isinstance(b,int):
        raise ValueError('noninteger coverage endpoint')
    return ((a+MINUTE-1)//MINUTE*MINUTE,b//MINUTE*MINUTE)


def main():
    path=HERE/'production-coverage.jsonl'
    archive=path.with_suffix('.jsonl.gz')
    reader=(lambda: gzip.open(archive,'rt')) if archive.exists() else path.open
    identities={}
    audits=[]
    coverage=[]
    final=None
    with reader() as source:
        for line in source:
            row=json.loads(line)
            final=row
            if row['kind']=='instrument': identities[row['id']]=row
            elif row['kind']=='audit': audits.append(row)
            elif row['kind']=='coverage': coverage.append(row)
    assert final and final['kind']=='complete','export snapshot incomplete'
    output=[]
    anomalies=[]
    for ident,identity in identities.items():
        fmt=Counter()
        audit_spans=[]
        structured=[]
        matching_audits=[a for a in audits if a['details'].get('instrument')==ident]
        for row in matching_audits:
            details=row['details']
            fmt['audits_total']+=1
            if details.get('basis')!=identity['basis']:
                fmt['other_basis']+=1
                continue
            fmt['current_basis']+=1
            for key in ('range_start','range_end','source','received_at','ranges'):
                if key not in details: fmt['missing_'+key]+=1
            if details.get('source') not in (None,identity['source']):
                fmt['explicit_wrong_source_accepted_by_old_reader']+=1
            try:
                if 'range_start' in details and details['range_start'] is not None:
                    int(details['range_start'])
                    if details.get('range_end') is not None: int(details['range_end'])
                received=details['received_at']
                if isinstance(received,bool) or not isinstance(received,int): raise ValueError('invalid received_at')
                cutoff=(received-5000)//MINUTE*MINUTE
                spans=[]
                for span in details['ranges']:
                    a,b=minute(span['start'],min(span['end'],cutoff))
                    if a<b: spans.append((a,b))
                    if span['start']%MINUTE or span['end']%MINUTE: fmt['fractional_minute_span']+=1
                audit_spans.extend(spans)
            except (ValueError,TypeError,KeyError) as error:
                fmt['invalid_record']+=1
                anomalies.append(dict(instrument=ident,audit_id=row['id'],error=type(error).__name__))
        for row in coverage:
            if row['instrument_id']!=ident: continue
            fmt['structured_all_sources']+=1
            if (row['source'],row['basis'])!=(identity['source'],identity['basis']):
                fmt['structured_other_identity']+=1
                continue
            a,b=minute(row['start'],row['end'])
            if a<b: structured.append((a,b))
        old=merged(audit_spans+structured)
        new=merged(structured)
        diff=subtract(old,new)
        backwards=subtract(new,old)
        output.append(dict(instrument=ident,source=identity['source'],basis=identity['basis'],formats=dict(fmt),
            audit_union=merged(audit_spans),compatibility_union=old,structured_union=new,
            compatibility_minus_structured=diff,structured_minus_compatibility=backwards,
            missing_minutes=sum(b-a for a,b in diff)//MINUTE,
            old_reader_error_possible=bool(fmt['invalid_record'])))
    report=dict(scope='Local Ubuntu interval comparison of one read-only official production snapshot, no modifications',
        records=dict(audits=len(audits),coverage=len(coverage),instruments=len(identities)),targets=output,
        anomalous_records=anomalies,limitations=[
            'Invalid records are quarantined locally; current reader may throw instead of returning this valid subset',
            'Old audit read does not enforce source; accepted explicit wrong-source evidence remains marked, not endorsed',
            'Snapshot equality does not prove concurrent catch-up, downstream OHLC/complete/revision equivalence or migration rollback'])
    (HERE/'production-coverage-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
    lines=['# 正式实例覆盖只读对照','',
        '在正式worker内执行有5秒statement timeout的read-only repeatable-read SELECT，Ubuntu本地计算区间；未创建unraid实例、修改数据或迁移。凭据未导出。',
        '', '| 身份 | 审计数 / 当前basis | 结构化匹配行 | 旧路径减结构化缺少分钟 | 缺source审计 | 异常审计 |',
        '| --- | --- | --- | --- | --- | --- |']
    for row in output:
        f=row['formats']
        lines.append(f"| {row['instrument']} / {row['source']} / {row['basis']} | {f.get('audits_total',0)} / {f.get('current_basis',0)} | {f.get('structured_all_sources',0)-f.get('structured_other_identity',0)} | {row['missing_minutes']} | {f.get('missing_source',0)} | {f.get('invalid_record',0)} |")
    lines+=['', '区间差集与格式分母见 [production-coverage-comparison.json](production-coverage-comparison.json)，原始白名单字段见 [production-coverage.jsonl.gz](production-coverage.jsonl.gz)，压缩往返与SHA256记录见 [manifest](production-coverage-manifest.json)。',
        '', '旧路径有效区间包含审计与结构化并集，按旧received_at五秒余量与完整分钟裁切；没有使用迁移当前时间扩展证明。缺source不等于允许猜测来源；explicit错误source单独计数。异常记录隔离只是对照行为，不代表当前生产读口可容错。',
        '', '此为单时刻区间对照。即使没有差集，仍须演练历史补齐与并发追赶、下游结果一致性及回退，方可切换读路径；没有以本报告授权生产修改。']
    (HERE/'production-coverage-comparison.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(dict(records=report['records'],missing_minutes={r['instrument']:r['missing_minutes'] for r in output},anomalies=len(anomalies))))


if __name__=='__main__': main()
