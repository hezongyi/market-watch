const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx=vm.createContext({URL,URLSearchParams,Map,Promise,Date,Intl,Error,
 location:{search:'?parent=http://localhost'},parent:{postMessage(){}},crypto:{randomUUID:()=> 'volume'},
 addEventListener(){},setTimeout,clearTimeout,atob:s=>Buffer.from(s,'base64').toString('utf8'),
 btoa:s=>Buffer.from(s).toString('base64')});
for(const file of ['series.js','bridge.js','indicators.js'])vm.runInContext(fs.readFileSync('../advanced-host/'+file,'utf8'),ctx);
ctx.page={bars:[{start:0,end:60000,open:'10',high:'11',low:'9',close:'10',volume:'12.25'},
 {start:60000,end:120000,open:'10',high:'11',low:'9',close:'10',volume:'0'},
 {start:120000,end:180000,open:'10',high:'11',low:'9',close:'10',volume:null}],
 indicators:[{series:[{key:'value',values:[{time:0,value:2},{time:60000,value:null}]}]}]};
const bars=vm.runInContext('barsOf(page,"1","MWP:BTCUSDT")',ctx);
assert.equal(bars[0].volume,12.25);assert.equal(bars[1].volume,0);assert.equal('volume' in bars[2],false);
ctx.synthetic='MWPY_'+Buffer.from(JSON.stringify({symbol:'BTCUSDT',spec:{name:'SMA'},key:'value'})).toString('base64');
const indicatorBars=vm.runInContext('barsOf(page,"1",synthetic)',ctx);
assert.equal(indicatorBars[0].volume,1);assert.equal(indicatorBars[1].volume,0);
console.log('Actual bridge preserves quantity/zero/unknown and synthetic validity protocol');
