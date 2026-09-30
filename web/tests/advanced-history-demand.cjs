const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = vm.createContext({Date,Map,Set,WeakMap,Promise,Math,JSON,setTimeout,clearTimeout});
vm.runInContext(fs.readFileSync('../advanced-host/history-demand.js','utf8'),context);
(async()=>{
 let now=1790000000000, spacing=6, resolution='60';
 const requests=[];
 const chart={resolution:()=>resolution,symbol:()=> 'XAUUSD',
  getTimeScale:()=>({barSpacing:()=>spacing,width:()=>1200}),getVisibleRange:()=>({to:now/1000+86400})};
 const widget={chartsCount:()=>1,chart:()=>chart,activeChart:()=>chart};
 const reporter=context.chartDemandReporter(widget,'client',async args=>requests.push(args),e=>{throw e},()=>now);
 await reporter.tick();
 assert.equal(requests[0].visible,200);
 assert.equal(requests[0].end,now);
 await reporter.tick(); assert.equal(requests.length,1);
 resolution='1D'; await reporter.tick(); assert.equal(requests.length,2);
 assert.equal(requests[0].id,requests[1].id);
 spacing=3;await reporter.tick();assert.equal(requests.at(-1).visible,400);
 now+=15000;await reporter.tick();assert.equal(requests.length,4);
 resolution='1M';await reporter.tick();assert.equal(requests.length,4);
 reporter.dispose();resolution='5';await reporter.tick();assert.equal(requests.length,4);
 console.log('Viewport demand counts spacing, shares pane identity, renews, excludes W/M and disposes');
})().catch(e=>{console.error(e);process.exit(1)});
