// Actual native sidebar: long identity must leave status and event time visible.
const {product}=require('./pro-charts-support.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const p=await product(),report={environment:'Ubuntu mw-pro-charts-20261011',cases:[]};
 try {
  await p.ui.getByRole('button',{name:'警报',exact:true}).click();
  for(const theme of ['Dark','Light']) {
   await p.host.evaluate(t=>widget.changeTheme(t),theme);
   for(const tab of ['警报','日志']) {
    await p.ui.getByRole('tab',{name:tab,exact:true}).click();
    await p.expect(p.ui.locator('.alert-row-subtitle').first()).toBeVisible();
    const rows=await p.ui.locator('.alert-row-subtitle').evaluateAll(ns=>ns.map(n=>{
     const walk=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let node,last;
     while(node=walk.nextNode())if(node.textContent.trim())last=node;
     const index=last.textContent.trimEnd().length-1,range=document.createRange();
     range.setStart(last,index);range.setEnd(last,index+1);
     const tail=range.getBoundingClientRect(),box=n.getBoundingClientRect();
     const state=n.querySelector('.alert-state');
     function luminance(color){return color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}
     const foreground=state&&luminance(getComputedStyle(state).color),background=state&&luminance(getComputedStyle(n.closest('.chart-alert-panel')).backgroundColor);
     return {text:n.textContent,tailOverflow:Math.max(0,tail.right-box.right),tailHeight:tail.height,stateContrast:state?(Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05):null};
    }));
    report.cases.push({theme,tab,rows,passed:rows.length>0&&rows.every(r=>r.tailOverflow<=1&&r.tailHeight>0&&(r.stateContrast===null||r.stateContrast>=4.5))});
   }
  }
  assert.ok(report.cases.every(c=>c.passed),'Status and event time must remain visible, with readable status contrast');
  assert.deepEqual(p.errors,[]);report.passed=true;
 }catch(e){report.failure=e.message;throw e;}
 finally {report.errors=p.errors;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-alert-subtitle.json',JSON.stringify(report,null,2)+'\n');await p.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
