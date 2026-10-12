"""Offline hypothesis comparison; not application code or original Pine source."""
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import json, hashlib, html, base64, argparse

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input',type=Path,default=Path(__file__).with_name('snapshot.jsonl'))
parser.add_argument('--output',type=Path,default=Path(__file__).parent)
parser.add_argument('--image',type=Path,default=Path('/home/quant/repos/Snipaste_2026-10-12_10-55-13.png'))
args=parser.parse_args()
OUT=args.output
OUT.mkdir(parents=True,exist_ok=True)
SOURCE=args.input
raw=[json.loads(line) for line in SOURCE.read_text().splitlines()]
assert raw[-1]['kind']=='complete'
bars=[row for row in raw if row['kind']=='managed_bar']
native=[row['payload'] for row in raw if row['kind']=='provider_bar']
by_start={row['start']:row for row in bars}
assert all(all(Decimal(row[key])==Decimal(by_start[row['start']][key]) for key in ('open','high','low','close')) for row in native)
Z=timezone(timedelta(hours=8))
def stamp(ms):return datetime.fromtimestamp(ms/1000,Z).isoformat()
def pivots(side,left=5,right=5,closed=False,strict_left=True,strict_right=True):
    result=[]
    for i in range(left,len(bars)-right):
        window=bars[i-left:i+right+1]
        if closed and not all(row['complete'] for row in window):continue
        value=Decimal(bars[i][side]);ext=max if side=='high' else min
        lv=ext(Decimal(row[side]) for row in bars[i-left:i]) if left else value
        rv=ext(Decimal(row[side]) for row in bars[i+1:i+right+1]) if right else value
        def cmp(other,strict):
            if side=='high':return value>other if strict else value>=other
            return value<other if strict else value<=other
        if (not left or cmp(lv,strict_left)) and (not right or cmp(rv,strict_right)):
            result.append(i)
    return result

# Screenshot-derived vertices and last visible dot of each historical level.
OBS={
 'high':[(86,154,72,531),(111,479,218,752),(128,700,270,922),(141,869,434,1065),(152,1013,449,1286),(169,1234,507,1299)],
 'low':[(80,76,143,453),(105,401,307,687),(123,635,389,856),(136,804,555,948),(144,909,648,1143),(158,1091,643,1221),(164,1169,629,1299)]
}
def x(i):return 13*i-964+(1 if i>=142 else 0)
price_slope=(629-507)/(1.12427-1.11719)
price_intercept=507+price_slope*1.12427
def y(p):return price_intercept-price_slope*float(p)
def price_at_y(py):return (price_intercept-py)/price_slope

report={'scope':'Ubuntu offline analysis of read-only existing production data; no app implementation',
 'source':'OANDA bid / EUR_USD / H4 / ny17; screenshot FXCM',
 'managed_count':len(bars),'native_count':len(native),'native_managed_exact_ohlc_matches':len(native),
 'input_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
 'first_start':stamp(bars[0]['start']),'last_start':stamp(bars[-1]['start']),
 'last_complete':bars[-1]['complete'],'time_labels':'UTC+8 compatibility, screenshot timezone not explicitly shown',
 'variants':{},'matches':[]}
for side in ['high','low']:
    report['variants'][side]={}
    for n in [1,2,3,4,5,6,7,10]:
        got=[i for i in pivots(side,n,n) if i>=74]
        expected=[r[0] for r in OBS[side]]
        report['variants'][side][f'{n}/{n}']={'indices':got,'extra':sorted(set(got)-set(expected)),'missing':sorted(set(expected)-set(got))}
    report['variants'][side]['left5_only']={'indices':[i for i in pivots(side,5,0) if i>=74]}
    report['variants'][side]['closed_5/5']={'indices':[i for i in pivots(side,closed=True) if i>=74]}
    report['variants'][side]['equal_policy_5/5']={f'{sl}/{sr}':pivots(side,strict_left=sl,strict_right=sr) for sl,sr in [(True,True),(True,False),(False,True),(False,False)]}
    got=pivots(side)
    for index,sx,sy,ex in OBS[side]:
        assert index in got
        position=got.index(index)
        following=got[position+1] if position+1<len(got) else None
        predicted_end=x(following+4) if following is not None else x(len(bars)-1)
        # One old low point near x=961 is obscured by the candlestick; don't mark it missing.
        report['matches'].append({'side':side,'index':index,'time':stamp(bars[index]['start']),
          'oanda_price':bars[index][side],'screenshot_price':1.12427 if side=='high' and index==169 else 1.11719 if side=='low' and index==164 else None,
          'screenshot_y':sy,'approx_screenshot_price_from_pixels':round(price_at_y(sy),6),
          'approx_price_error_pips':round((price_at_y(sy)-float(bars[index][side]))*10000,3),
          'screenshot_start_x':sx,'predicted_start_x':x(index),'start_error_pixels':sx-x(index),
          'screenshot_end_x':ex,'predicted_end_x':predicted_end,'end_error_pixels':ex-predicted_end,
          'right5_index':index+5,'right5_bar_complete':bars[index+5]['complete'],
          'right5_bar_end':stamp(bars[index+5]['end'])})

# Draw the inferred state model in original screenshot coordinates. A +0.7 pip
# shift aids visual comparison only; computation uses untouched OANDA values.
parts=['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1507 732" width="1507" height="732">',
 '<rect width="1507" height="732" fill="#101010"/>',
 '<text x="8" y="17" fill="#ddd" font-size="13">OANDA EURUSD H4 · inferred 5/5 Pivot + shifted/unshifted levels · last bar incomplete</text>']
for p in [1.114,1.116,1.118,1.12,1.122,1.124,1.126,1.128,1.13,1.132,1.134,1.136,1.138,1.14,1.142,1.144,1.146,1.148,1.15]:
    py=y(p);parts.append(f'<path d="M0 {py:.2f} H1430" stroke="#444" stroke-width=".6"/><text x="1450" y="{py+4:.2f}" fill="#aaa" font-size="11">{p:.5f}</text>')
shift=.00007
for i,row in enumerate(bars):
    px=x(i)
    if px<-12:continue
    vals={k:float(row[k])+shift for k in ['open','high','low','close']}
    color='#089981' if vals['close']>=vals['open'] else '#f23645'
    top,bottom=sorted([y(vals['open']),y(vals['close'])])
    parts.append(f'<path d="M{px} {y(vals["high"]):.2f} V{y(vals["low"]):.2f}" stroke="{color}"/><rect x="{px-4}" y="{top:.2f}" width="8" height="{max(1,bottom-top):.2f}" fill="{color}"/>')
for side,color in [('high','#f23645'),('low','#00bcd4')]:
    pts=pivots(side)
    for position,i in enumerate(pts):
        following=pts[position+1] if position+1<len(pts) else None
        end=following+4 if following is not None else len(bars)-1
        py=y(float(bars[i][side])+shift)
        # Union of carried state at offset=0 and offset=-5. Current bridge is
        # an inferred visual equivalent, not a claim about original Pine code.
        last=len(bars)-1
        positions=set(range(i,following)) | set(range(i+5,following+5)) if following is not None else set(range(i,last-5+1)) | set(range(i+5,last+1))
        for k in sorted(positions):
            if k<74 or k>last:continue
            parts.append(f'<circle cx="{x(k)}" cy="{py:.2f}" r="2.5" fill="{color}"/>')
        if following is None and x(i)>0:
            parts.append(f'<path d="M{x(i)} {py:.2f} H{x(len(bars)-1)}" stroke="{color}" stroke-width="2"/>')
for i in [82,88,100,112,124,136,148,160,172]:
    px=x(i);label=datetime.fromtimestamp(bars[i]['start']/1000,Z).strftime('%m-%d')
    parts.append(f'<path d="M{px} 25 V700" stroke="#555" stroke-width=".5"/><text x="{px-15}" y="723" fill="#aaa" font-size="11">{label}</text>')
parts.append('<text x="8" y="42" fill="#ddd" font-size="12">Display-only +0.7 pip shift; pivots calculated from original values. Preview high 1.12420 is not closed-confirmed.</text></svg>')
svg=''.join(parts)
(OUT/'reconstruction.svg').write_text(svg)
(OUT/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
(OUT/'ohlc.json').write_text(json.dumps({'scope':report['scope'],'source':report['source'],'bars':bars},ensure_ascii=False,indent=2))
image64=base64.b64encode(args.image.read_bytes()).decode()
table=''.join(f'<tr><td>{r["side"]}</td><td>{r["index"]}</td><td>{html.escape(r["time"])}</td><td>{r["oanda_price"]}</td><td>{r["start_error_pixels"]}</td><td>{r["end_error_pixels"]}</td><td>{r["right5_bar_complete"]}</td></tr>' for r in report['matches'])
page=f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Patternsmart 截图与 5/5 模型对照</title><style>body{{background:#141414;color:#ddd;font:16px sans-serif;margin:24px}}img,svg{{width:100%;height:auto}}table{{border-collapse:collapse;font-size:13px}}td,th{{padding:8px;border:1px solid #555}}p{{max-width:1000px;line-height:1.6}}</style><h1>截图与离线推断模型对照</h1><p>读取现有生产数据：175 根 OANDA bid H4，173 根原生缓存重叠 OHLC 全部一致。截图来源 FXCM。左右各 5 根可匹配可见的 6 个高点、7 个低点；最新高点需要当前未完成柱，不能称为收盘确认。下面重构图仅为显示比较平移 +0.7 pip，计算未修改原价格。模型不是原版 Pine 源码。</p><h2>用户截图</h2><img src="data:image/png;base64,{image64}" alt="用户提供的 FXCM H4 截图"><h2>OANDA 数据上的推断模型</h2>{svg}<h2>柱位置核对</h2><p>索引从导出第一根开始；旧低点末端的 -13 px 差异来自蜡烛遮挡。UTC+8 时间标签与截图相容，但截图未明确标注时区。</p><table><tr><th>类型</th><th>索引</th><th>生产柱开始时间 UTC+8</th><th>原价格</th><th>起点误差 px</th><th>终点误差 px</th><th>第5右柱完成</th></tr>{table}</table><p>等高/等低策略在此样本上不可辨别。参数强度、历史回画和盘中预览应分别定义。统计表 15/16 未复原。</p></html>'''
(OUT/'comparison.html').write_text(page)
print(json.dumps({'managed':len(bars),'native_matches':len(native),'matches':len(report['matches']),
 'max_start_error_px':max(abs(r['start_error_pixels']) for r in report['matches']),
 'old_high_end_errors':[r['end_error_pixels'] for r in report['matches'] if r['side']=='high' and r['index']!=169],
 'current_high_confirmed':report['matches'][5]['right5_bar_complete'],'out':str(OUT)},ensure_ascii=False))
