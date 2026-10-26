// Run after mwa-search.playwriter.cjs with its real native dialog open.
const assert=require('node:assert');
const fs=require('node:fs');
const native=state.page.frames().find(f=>f.url().startsWith('blob:https://chart-test.kookvv.com:8443/'));
const dialog=native.getByRole('dialog',{name:'商品代码搜索',exact:true});
const search=dialog.getByRole('searchbox',{name:'搜索',exact:true});
const report={passed:false,cases:[],pageErrors:[]};
const onError=e=>report.pageErrors.push(String(e));
state.page.on('pageerror',onError);
async function change(name,action,params,expected) {
 const response=state.page.waitForResponse(r=>{
  const u=new URL(r.url());return u.pathname==='/api/market-data/series/page' && Object.entries(params).every(([k,v])=>u.searchParams.get(k)===v);
 },{timeout:15000});
 await action();
 const result=await response;
 assert.equal(result.status(),200);
 const payload=await result.json();
 // Native pagination keeps a small load-more sentinel when more rows remain.
 if(!payload.has_more)await dialog.getByRole('progressbar').waitFor({state:'hidden',timeout:10000});
 else await dialog.locator('[data-symbol-name]').first().waitFor({state:'visible',timeout:10000});
 if(expected)await dialog.getByText(expected,{exact:true}).first().waitFor({state:'visible',timeout:10000});
 report.cases.push({name,status:result.status(),url:result.url(),snapshot:await dialog.ariaSnapshot()});
}
try {
 const source=dialog.getByRole('button',{name:'来源',exact:true});
 if(await source.getAttribute('aria-expanded')!=='true')await source.click();
 await change('FXCM source',()=>native.getByRole('option',{name:'FXCM',exact:true}).click(),{source:'fxcm'},'EURUSD');
 await dialog.getByRole('button',{name:'行情类型',exact:true}).click();
 await change('FXCM platform',()=>native.getByRole('option',{name:'平台行情',exact:true}).click(),{source:'fxcm',kind:'provider'},'EURUSD');
 await change('FXCM gold',()=>search.fill('XAUUSD'),{source:'fxcm',kind:'provider',query:'XAUUSD'},'XAUUSD');
 const rows=await dialog.locator('[data-symbol-name]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-symbol-name')));
 assert(rows.length>0);report.gold_native_rows=rows;
 await state.page.screenshot({path:state.searchCheck.reportDir+'/fxcm-gold-search.png',scale:'css'});
 await change('No match finishes',()=>search.fill('MW_NO_SUCH_SYMBOL_93711'),{source:'fxcm',kind:'provider',query:'MW_NO_SUCH_SYMBOL_93711'});
 await dialog.locator('[data-symbol-name]').first().waitFor({state:'hidden',timeout:10000});
 assert.equal(await dialog.getByRole('button',{name:'重试搜索',exact:true}).count(),0);
 await change('Empty query lists FXCM',()=>search.fill(''),{source:'fxcm',kind:'provider',query:''});
 assert(await dialog.locator('[data-symbol-name]').count()>0);
 assert.deepEqual(report.pageErrors,[]);
 report.passed=true;
} finally {
 report.logs=await getLatestLogs({page:state.page,sinceLastCall:true});
 state.page.off('pageerror',onError);
 fs.writeFileSync(state.searchCheck.reportDir+'/search-filters.json',JSON.stringify(report,null,2));
 console.log({passed:report.passed,cases:report.cases.map(c=>c.name)});
}
