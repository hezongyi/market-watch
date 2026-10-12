// Chromium touch emulation; Android/iOS hardware remains an explicit limit.
const {product}=require('./pro-charts-support.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto');
(async()=>{const r={environment:'Ubuntu mw-pro-charts-20261011',device:'Chromium touch simulation',cases:[]};
 for(const viewport of [{width:375,height:812},{width:915,height:412}]) {
  const p=await product({viewport,isMobile:true,hasTouch:true});
  try {
    const writes=[];p.page.on('request',q=>{if(q.method()==='POST'&&q.url().includes('/api/advanced-charts/'))writes.push(new URL(q.url()).pathname);});
    const list=await (await p.page.request.get('http://localhost:19997/api/advanced-charts/workspaces?limit=1')).json();const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex'),before=hash(list[0].document);
    await p.expect(p.page.getByText('手机只读看盘。编辑图表、绘图和告警请使用桌面浏览器；桌面工作区布局仍保留。',{exact:true})).toBeVisible();
    assert.equal(await p.host.evaluate(()=>widget.chartsCount()),1);
    assert.equal(await p.ui.getByRole('button',{name:'数据中心',exact:true}).count(),0);assert.equal(await p.ui.getByRole('button',{name:'指标',exact:true}).count(),0);
    await p.page.mouse.wheel(0,120);await p.page.waitForTimeout(500);
    await p.page.goto('http://localhost:19997/');await p.expect(p.page.getByText('专业图表在手机上只读看盘；编辑功能请使用桌面浏览器。',{exact:true})).toBeVisible();
    const after=await (await p.page.request.get('http://localhost:19997/api/advanced-charts/workspaces?limit=1')).json();assert.equal(hash(after.find(x=>x.id===list[0].id).document),before);assert.deepEqual(writes,[]);assert.deepEqual(p.errors,[]);
    r.cases.push({viewport,desktopDocumentUnchanged:true,writes,errors:p.errors});
  }catch(e){r.failure=e.stack;throw e;}finally{await p.browser.close();fs.writeFileSync('docs/verification/pro-charts-20261011/browser-mobile.json',JSON.stringify(r,null,2));}
 }
 r.passed=true;fs.writeFileSync('docs/verification/pro-charts-20261011/browser-mobile.json',JSON.stringify(r,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
