// Exercise the shared adapter without adding/removing any watchlist symbol.
const assert=require('node:assert');
const fs=require('node:fs');
const native=state.page.frames().find(f=>f.url().startsWith('blob:https://chart-test.kookvv.com:8443/'));
const dialog=native.getByRole('dialog',{name:'添加商品代码',exact:true});
const pattern='**/api/market-data/series/page?*';
const fault=r=>r.fulfill({status:500,contentType:'application/json',body:'{"detail":"isolated watchlist search failure"}'});
const report={passed:false,pageErrors:[]};
const onError=e=>report.pageErrors.push(String(e));
state.page.on('pageerror',onError);
try {
 await state.page.route(pattern,fault);
 await dialog.getByRole('searchbox',{name:'搜索',exact:true}).fill('EURUSD');
 await dialog.getByRole('button',{name:'重试搜索',exact:true}).waitFor({state:'visible',timeout:10000});
 await dialog.getByRole('progressbar').waitFor({state:'hidden',timeout:5000});
 report.failure=await dialog.ariaSnapshot();
 await state.page.unroute(pattern,fault);
 const response=state.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market-data/series/page'&&r.status()===200);
 await dialog.getByRole('button',{name:'重试搜索',exact:true}).click();
 await response;
 await dialog.getByText('EURUSD',{exact:true}).first().waitFor({state:'visible',timeout:10000});
 await dialog.getByRole('progressbar').waitFor({state:'hidden',timeout:10000});
 report.recovered=await dialog.ariaSnapshot();
 assert.deepEqual(report.pageErrors,[]);report.passed=true;
 await dialog.getByRole('button',{name:'关闭菜单',exact:true}).click();
} finally {
 await state.page.unroute(pattern,fault);state.page.off('pageerror',onError);
 report.logs=await getLatestLogs({page:state.page,sinceLastCall:true});
 fs.writeFileSync(state.searchCheck.reportDir+'/watchlist-search.json',JSON.stringify(report,null,2));
 console.log({passed:report.passed,pageErrors:report.pageErrors});
}
