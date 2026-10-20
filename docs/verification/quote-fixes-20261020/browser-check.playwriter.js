state.watchPrecisionRows=await state.priceRealNative.locator('[data-test-id-widget-type="watchlist"] [data-symbol-full]').evaluateAll(rows=>rows.filter(el=>el.getAttribute('data-symbol-full').startsWith('MWH:')).map(el=>({ticker:el.getAttribute('data-symbol-full'),symbol:el.querySelector('[class*="symbolNameText-"]')?.textContent,displayed:el.querySelector('[class*="last-"] [class*="inner-"]')?.textContent,aria:el.querySelector('[class*="last-"]')?.getAttribute('aria-label')})));
state.watchPrecisionEvidence=await state.priceRealHost.evaluate(rows=>rows.map(row=>{
 const meta=presentationFor(row.ticker),raw=quoteSnapshotRows.get(row.ticker),presentation=chartQuotePresentation(raw,meta);
 const expected=new Intl.NumberFormat('en-US',{minimumFractionDigits:meta.precision,maximumFractionDigits:meta.precision}).format(raw.v.lp);
 return {...row,raw_price:raw.v.lp,source:meta.source,series_kind:meta.series_kind,precision:meta.precision,asset_type:meta.asset_type??null,display_precision:meta.display_precision??null,overridden_scale:presentation.v.mw_display_pricescale,native_declared_scale:10**meta.precision,effective_scale:chartQuoteScale(presentation,{pricescale:10**meta.precision}),expected,matches:row.displayed===expected};
}),state.watchPrecisionRows);
require('node:fs').writeFileSync('/home/quant/repos/market-watch-issue75-integrated-20261019/docs/verification/quote-fixes-20261020/browser-evidence.json',JSON.stringify({observed_at:new Date().toISOString(),url:state.quoteFixPage.url(),rows:state.watchPrecisionEvidence},null,2)+'\n');
await state.priceRealNative.locator('[data-test-id-widget-type="watchlist"]').screenshot({path:'/home/quant/repos/market-watch-issue75-integrated-20261019/docs/verification/quote-fixes-20261020/watchlist-current.png',scale:'css'});
console.log(state.watchPrecisionEvidence);
if(state.watchPrecisionEvidence.length !== 3 || state.watchPrecisionEvidence.some(r=>!r.matches))throw Error('Custom precision acceptance failed');
