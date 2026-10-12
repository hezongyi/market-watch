"""Offline reconstruction of candidate interval statistics; not original Pine code."""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP, ROUND_FLOOR
from datetime import datetime, timezone, timedelta
import argparse, json, hashlib, statistics

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input',type=Path,default=Path(__file__).with_name('long_snapshot.jsonl'))
parser.add_argument('--tail',type=Path,default=Path(__file__).with_name('snapshot.jsonl'))
parser.add_argument('--output',type=Path,default=Path(__file__).with_name('long_statistics.json'))
args=parser.parse_args()
records=[json.loads(line) for line in args.input.read_text().splitlines()]
assert records[-1]['kind']=='complete'
native=[row['payload'] for row in records if row['kind']=='provider_bar']
tail=[json.loads(line) for line in args.tail.read_text().splitlines()]
assert tail[-1]['kind']=='complete'
managed=[row for row in tail if row['kind']=='managed_bar']
old={row['start']:row for row in managed}
overlap=[row for row in native if row['start'] in old]
assert all(all(Decimal(row[key])==Decimal(old[row['start']][key]) for key in ['open','high','low','close']) for row in overlap)
appended=[row for row in managed if row['start']>native[-1]['start']]
bars=native+appended
assert len({row['start'] for row in bars})==len(bars)
zone=timezone(timedelta(hours=8))
def iso(stamp):return datetime.fromtimestamp(stamp/1000,zone).isoformat()
def pivot_indices(side,strict_left=True,strict_right=True,closed=False):
    points=[]
    ext=max if side=='high' else min
    for i in range(5,len(bars)-5):
        if closed and not all(row['complete'] for row in bars[i-5:i+6]):continue
        value=Decimal(bars[i][side])
        left=ext(Decimal(row[side]) for row in bars[i-5:i])
        right=ext(Decimal(row[side]) for row in bars[i+1:i+6])
        def compare(other,strict):
            if side=='high':return value>other if strict else value>=other
            return value<other if strict else value<=other
        if compare(left,strict_left) and compare(right,strict_right):points.append(i)
    return points
def summary(points):
    gaps=[b-a for a,b in zip(points,points[1:])]
    mean=Decimal(sum(gaps))/len(gaps)
    return {'point_count':len(points),'interval_count':len(gaps),'interval_sum':sum(gaps),
      'first_index':points[0],'last_index':points[-1],
      'first_time':iso(bars[points[0]]['start']),'last_time':iso(bars[points[-1]]['start']),
      'mean':float(mean),'round_half_up':int(mean.to_integral_value(rounding=ROUND_HALF_UP)),
      'floor':int(mean.to_integral_value(rounding=ROUND_FLOOR)),
      'median':statistics.median(gaps),'mean_excluding_both_endpoints':float(mean-1),
      'mean_including_both_endpoints':float(mean+1),
      'bar_index_divided_by_point_count':(len(bars)-1)/len(points)}
report={'scope':'read-only existing production cache; calculations local Ubuntu',
 'source':'OANDA EUR_USD bid H4; screenshot FXCM',
 'production_snapshot':records[0],
 'native_count':len(native),'tail_count':len(appended),'total_count':len(bars),
 'tail_scope':'two managed candles frozen in original screenshot-time export, not refreshed',
 'overlap_exact_ohlc':len(overlap),'first':iso(bars[0]['start']),'last':iso(bars[-1]['start']),
 'sha256':{str(path.name):hashlib.sha256(path.read_bytes()).hexdigest() for path in [args.input,args.tail]},
 'statistics':{},'counterexamples':{},'points':{}}
for side in ['high','low']:
    points=pivot_indices(side)
    report['statistics'][side]={}
    for name,sl,sr,closed in [('strict_preview',True,True,False),('strict_closed',True,True,True),
      ('relaxed_preview',False,False,False),('strict_left_relaxed_right',True,False,False),
      ('relaxed_left_strict_right',False,True,False)]:
        report['statistics'][side][name]=summary(pivot_indices(side,sl,sr,closed))
    report['points'][side]=[{'index':i,'start':bars[i]['start'],'time':iso(bars[i]['start']),
      'price':bars[i][side],'right5_end':iso(bars[i+5]['end']),
      'right5_complete':bars[i+5]['complete']} for i in points]
    gaps=[b-a for a,b in zip(points,points[1:])]
    report['counterexamples'][side]={}
    for n in [10,20,50,100,200]:
        subset=points[-n-1:]
        report['counterexamples'][side][f'last_{n}_intervals']=summary(subset)
    for n in [500,1000,2000,3000]:
        subset=[i for i in points if i>=len(bars)-n]
        report['counterexamples'][side][f'last_{n}_bars']=summary(subset)
    for n in [10,14,20,50]:
        ema=sum(gaps[:n])/n
        for gap in gaps[n:]:ema=2/(n+1)*gap+(1-2/(n+1))*ema
        report['counterexamples'][side][f'ema_{n}_intervals']={'value':ema}
args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
print(json.dumps({'total':len(bars),'overlap_exact':len(overlap),
 'high':report['statistics']['high']['strict_preview'],
 'low':report['statistics']['low']['strict_preview']},ensure_ascii=False))
