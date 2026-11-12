# Sina futures native period source excerpts

Original source bytes are preserved in the matching `.gz` archives. The manifest records archive names and uncompressed SHA-256 hashes; use `gzip -dc FILE.gz` to read them.

## Page mounts nf_ futures chart
source: https://n.sinaimg.cn/finance/futures/moudler20200421.js
file: moudler20200421.js; zero-based character offset: 47819

```javascript
KKE.api('plugins.sinaTKChart.get', {
						symbol: 'nf_' + futures_app.code,//֤ȯ���� sh600650
						dom_id: 'box-flash-wrap'//����ͼ�ε�dom����id
					});
					//oldChart.href=oldChart.href.replace('$symbol',futures_app.code)+'?showflash';

```

## SDK module URL template
source: https://finance.sina.com.cn/sinafinancesdk/js/sf_sdk.js
file: sf_sdk.js; zero-based character offset: 868

```javascript
MOD_URL_PROD_S:"https://finance.sina.com.cn/sinafinancesdk/js/$moduleName.js",getModUrl:function(){return this.custom_mo
```

## Futures server routes
source: https://finance.sina.com.cn/sinafinancesdk/js/datas/k.js
file: datas-k.js; zero-based character offset: 2415

```javascript
NF:{DAYK_URL:"http://stock2.finance.sina.com.cn/futures/api/jsonp.php/$cb/InnerFuturesNewService.getDailyKLine?symbol=$symbol&_=$rn",MINK_URL:"http://stock2.finance.sina.com.cn/futures/api/jsonp.php/$cb/InnerFuturesNewService.getFewMinLine?symbol=$symbol&type=$scale",INIT_URL:"http://stock.finance.sina.com.cn/futures/api/jsonp.php/$cb/InterfaceInfoService.getMarket?category=nf&symbol=$symbol",INIT_VAR_PRE:"kke_future_"},global_index:{DAYK_URL:"http://stock.finance.sina.com.cn
```

## Daily processor computes week and month
source: https://finance.sina.com.cn/sinafinancesdk/js/datas/k.js
file: datas-k.js; zero-based character offset: 4258

```javascript
alVolume*c,date:n.ddt(p)}),d=i.issueprice,u=i.name}if(t.length<1)return[t,void 0,void 0,void 0];var v=!isNaN(d)&&d>0?d:t[0].open;e.oc(t[0],{prevclose:v,name:u,symbol:s});var g=a.mw(t,i,v,c,r.endDay),b=g[0],y=g[1],N=void 0;if(a.pd(t,null),a.pd(b,null),a.pd(y,null),i&&i.settlement){var w=t[t.length-1];w.ampP=w.amplitude/i.settlement,w.change=w.close-i.settlement,w.percent=w.change/i.settlement}return e.oc(b[0],{name:u,symbol:s}),e.oc(y[0],{name:u,symbol:s}),o.ytd&&(N=a.yd(t),e.oc(N[0],{name:u,symbol:s})),[t,b,y,N]},c=function(t,n,a){var i=e.market(t),s=i?r[i][n?"MINK_URL":"DAYK_URL"]:null;return(o||a)&&(s=e.getSUrl(s)),s},h=function(t,n){var a,i,s=e.market(t);return r[s]&&(a=r[s].DAYK_RE_URL,i=r[s].RE_VAR),a&&(o|
```

## Non-minute loader fetches daily then returns derived week/month
source: https://finance.sina.com.cn/sinafinancesdk/js/datas/k.js
file: datas-k.js; zero-based character offset: 11790

```javascript
x=function(n,a){var o=L(n),r=function(r){var c=r?r.data[0]:void 0,h=s(),d=new Date,u=[d.getFullYear(),d.getMonth()+1,d.getDate()].join("_"),p="_"+o.kSb.replace(/\W/g,"")+u;t(o.kUrl.replace("$symbol",o.kSb).replace("$rn",u).replace("$cb","var%20"+p+"="),function(){var t;if(o.isCompressData){var r=o.kSb.replace(".","$");t=window["KLC_KL_"+r],t=i(t)}else{t=window[p];var s=n.dataformatter||o.dayDataHandler||m;t=s(t)}var d=l(t,c,n);d?h.data={hq:c,day:d[0],week:d[1],month:d[2],ytd:d[3]||null}:h.msg="error",e.isFunc(a)&&a(h)},function(){if(c){var t=l(null,c,n);t?h.data={hq:c,day:t[0],week:t[1],month:t[2],ytd:t[3]||null}:h.msg="error",e.isFunc(a)&&a(h)}else h.msg="error",h.data={hq:c},e.isFunc(a)&&a(h)},{market:o.market,symbol:o.hqSb,type:"k"})};"undefined"==typeof o.market||"UNKNOWN"===o.market?r():KKE.api("datas.hq.get",{symbol:o.hqSb,cancelEta
```

## kUtil.mw groups by same-week and same-month
source: https://finance.sina.com.cn/sinafinancesdk/js/sf_sdk.js
file: sf_sdk.js; zero-based character offset: 37114

```javascript
this.kUtil={mw:function(t,e,n,o,i){"number"!=typeof o&&(o=0);var r=t.length,a=t[0];o>1&&(a.volume/=o);var s,l=[],u=[],c=[];if(1==r)l[0]={open:e.open,high:e.high,low:e.low,close:e.price,volume:e.totalVolume,amount:e.totalAmount,date:H.dd(e.date)},u[0]={open:e.open,high:e.high,low:e.low,close:e.price,volume:e.totalVolume,amount:e.totalAmount,date:H.dd(e.date)},c[0]={open:e.open,high:e.high,low:e.low,close:e.price,volume:e.totalVolume,amount:e.totalAmount,date:H.dd(e.date)};else for(var h,d=a.open,f=a.high,p=a.low,g=a.close,v=a.volume,m=a.date,b=a.amount,y=a.open,x=a.high,w=a.low,N=a.close,S=a.volume,R=a.date,k=a.amount,E=a.open,A=a.high,C=a.low,L=a.close,F=a.volume,I=a.date,D=a.amount,T=1;r>T;T++)a=t[T],o>1&&(a.volume/=o,a.postVol&&(a.postVol/=o)),H.gw(t[T-1].date,a.date)?(a.high>f&&(f=a.high),a.low<p&&(p=a.low),g=a.close,v+=a.volume,b+=a.amount,m=a.date):(isNaN(i)||(s=m.getDay(),0==s&&(s=7),h=s-i,h>0&&(m=H.ddt(m),m.setDate(m.getDate()-h))),l.push({open:d,high:f,low:p,close:g,volume:v,date:m,amount:b}),d=a.open,f=a.high,p=a.low,g=a.close,v=a.volume,b=a.amount,m=a.date),H.gm(t[T-1].date,a.date)?(a.high>x&&(x=a.high),a.low<w&&(w=a.low),N=a.close,S+=a.volume,k+=a.amount,R=a.date):(isNaN(i)||(s=R.getDay(),0==s&&(s=7),h=s-i,h>0&&(R=H.ddt(R),R.setDate(R.getDate()-h))),u.push({open:y,high:x,low:w,close:N,volume:S,date:R,amount:k}),y=a.open,x=a.high,w=a.low,N=a.close,S=a.volume,k=a.amount,R=a.date),H.gy(t[T-1].date,a.date)?(a.high>A&&(A=a.high),a.low<C&&(C=a.low),L=a.close,F+=a.volume,D+=a.amount,I=a.date):(c.push({open:E,high:A,low:C,close:L,volume:F,date:I,amount:D}),E=a.open,A=a.high,C=a.low,L=a.close,F=a.volume,I=a.date),T==r-1&&(l.push({open:d,high:f,low:p,close:g,volume:v,date:m,amount:b}),u.push({open:y,high:x,low:w,close:N,volume:S,date:R,amount:k}),c.push({open:E,high:A,low:C,close:L,volume:F,date:I,amount:D}));return l[0].prevclose=n,u[0].prevclose=n,c[0].prevclose=n,[l,u,c]},nc:function(t,e,n,o){if(t&&!(t.length<1)){o=o||{};var i=t[t.length-1];if(168==n&&H.gw(i.date,e.date)||720==n&&H.gm(i.date,e.date))return i.day=String(e.today).split("-").join("/"),void(i.date=H.dd(e.date));i=t[t.length-1];var r=i.close,a=e.price-r,s=a/r;t.push(
```

## Futures menu includes week and month
source: https://finance.sina.com.cn/sinafinancesdk/js/plugins/sinaTKChart.js
file: plugins-sinaTKChart.js; zero-based character offset: 82533

```javascript
case"NF":l.menu.tab=[{lab:"\u5206\u65f6",v:"t1",t:"T"},{lab:"5\u65e5",v:"t5",t:"T"},{lab:"\u5e74\u7ebf",v:"kcl",t:"K"},{lab:"\u65e5K",v:"kd",t:"K"},{lab:"\u5468K",v:"kw",t:"K"},{lab:"\u6708K",v:"km",t:"K"},{lab:"\u5e74K",v:"ky",t:"K"},{lab:"5\u5206",v:"k5",t:"K"},{lab:"15\u5206",v:"k15",t:"K"},{lab:"30\u5206",v:"k30",t:"K"},{lab:"60\u5206",v:"k60",t:"K"}],l.api.t.tCharts=[[{name:"TVOL"},{name:"POSITION"},{name:"BLANKCTN"}],{callback:function(){I(K)}}],l.api.t.showScale="pct",l.param=o.param}o=l}return o}function f(e){return/^(sh51\d{4}|sz159\d{3})$/.test(e)?"ETF":
```

## Chart module bundles same daily to weekly/monthly conversion
source: https://finance.sina.com.cn/sinafinancesdk/js/chart/h5k.js
file: chart-h5k.js; zero-based character offset: 5700

```javascript
:s.postAmount,postVol:s.postVolume})}m=s.issueprice,p=s.name}if(t.length<1)return[t,void 0,void 0,void 0];var _=!isNaN(m)&&m>0?m:t[0].open;e.oc(t[0],{prevclose:_,name:p,symbol:l});var v=n.mw(t,s,_,c,r.endDay),g=v[0],k=v[1],N=v[2],$=void 0;if(n.pd(t,null),n.pd(g,null),n.pd(k,null),n.pd(N,null),s&&s.settlement){var w=t[t.length-1];w.ampP=w.amplitude/s.settlement,w.change=w.close-s.settlement,w.percent=w.change/s.settlement}return e.oc(g[0],{name:p,symbol:l}),e.oc(k[0],{name:p,symbol:l}),e.oc(N[0],{name:p,symbol:l}),o.ytd&&($=n.yd(t),e.oc($[0],{name:p,symbol:l})),[t,g,k,$,N]},c=function(t,a,n){var s=e.market(t);"SI"==s&&(s="CN");var l=s?r[s][a?"MINK_URL":"DAYK_URL"]:null;return(o||n)&&(l=e.getSUrl(l)),l},u=function(t,a){var n,s,l=e.market(t);return r[l]&&(n=r[l].
```
