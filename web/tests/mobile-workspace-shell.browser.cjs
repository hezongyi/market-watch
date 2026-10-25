const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {buildSync} = require("esbuild");
const {chromium} = require("@playwright/test");

const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MobileWorkspaceShell} from '../src/advanced/MobileWorkspaceShell.tsx';
function Harness() {
  const [workspace, setWorkspace] = useState('workspace-a');
  const [symbols, setSymbols] = useState(['MWP:EURUSD']);
  const props = {
    tab: window.__tab || 'chart', onTab: tab => {window.__tab=tab;root.render(<Harness/>);},
    directory: [{original_index:0,original_chart_id:'chart-a',symbol:'MWP:EURUSD',resolution:'60'}, {original_index:1,original_chart_id:'chart-b',symbol:'MWP:GBPUSD',resolution:'5'}],
    selectedIndex:0, onSelectChart:index=>window.__events.push(['chart',index]),
    onOpenAlerts:()=>window.__events.push(['alerts']), onFullscreen:()=>{}, onRefresh:()=>{},
    workspaceName:'Same name', activeWorkspaceId:workspace,
    workspaces:[{id:'workspace-a',name:'Same name'},{id:'workspace-b',name:'Same name'}],
    onWorkspace:id=>{window.__events.push(['workspace',id]);setWorkspace(id);},
    onOpenTicker:ticker=>window.__events.push(['open',ticker]), onSearch:()=>{},
    searchResults:[{ticker:'MWP:GBPUSD',label:'GBPUSD'}], onSystemMessages:()=>window.__events.push(['notices']), onDataStatus:()=>window.__events.push(['data']), onHistoryDetails:()=>window.__events.push(['history']), onHistoryCapacity:()=>window.__events.push(['capacity']),
    watchlists:[{id:'list-a',title:'Primary',symbols}], activeWatchlist:'list-a',
    onWatchlistChange:()=>{}, onWatchlistEdit:setSymbols,
    onAddTicker:async ticker=>{if(window.__failAdd)throw Error('offline');setSymbols(current=>current.includes(ticker)?current:[...current,ticker]);},
    flags:{}, onFlag:()=>{}, theme:'dark'
  };
  return <div className="advanced-workspace" data-theme="dark" data-mobile="true"><MobileWorkspaceShell {...props}/></div>;
}
const root = createRoot(document.getElementById('root'));
window.__events=[];
window.__render=()=>root.render(<Harness/>);
window.__render();
`;
const bundle = buildSync({stdin:{contents:entry,resolveDir:__dirname,sourcefile:'mobile-shell-harness.tsx',loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic'}).outputFiles[0].text;
const css = fs.readFileSync(path.resolve(__dirname,'../src/advanced/advanced.css'),'utf8');

(async()=>{
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="root"></div>');
    await page.addStyleTag({content:css});
    await page.addScriptTag({content:bundle});
    const nav=page.getByRole('navigation',{name:'移动端导航'});
    for(const viewport of [{width:375,height:667},{width:390,height:844},{width:915,height:412}]) {
      await page.setViewportSize(viewport);
      for(const tab of ['图表','自选','告警','更多']) {
        await nav.getByRole('button',{name:new RegExp(tab)}).click();
        await page.waitForTimeout(30);
        const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
        assert.ok(dimensions.scroll<=dimensions.client,`${viewport.width}x${viewport.height} ${tab} horizontal overflow: ${JSON.stringify(dimensions)}`);
      }
    }
    await nav.getByRole('button',{name:/图表/}).click();
    assert.match(await page.locator('.mobile-chart-picker').innerText(),/平台行情 · 60/);
    const workspaceSelect=page.getByLabel('选择工作区');
    assert.equal(await workspaceSelect.inputValue(),'workspace-a');
    await workspaceSelect.selectOption('workspace-b');
    assert.deepEqual(await page.evaluate(()=>window.__events.find(event=>event[0]==='workspace')),['workspace','workspace-b']);
    await nav.getByRole('button',{name:/自选/}).click();
    await page.getByLabel('搜索品种').fill('GBPUSD');
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.evaluate(()=>window.__failAdd=true);
    await page.getByRole('button',{name:/GBPUSD/}).click();
    await page.getByRole('alert').waitFor({state:'visible'});
    assert.match(await page.getByRole('alert').innerText(),/加入自选失败/);
    assert.equal(await page.locator('.mobile-symbol').count(),1);
    assert.equal(await page.evaluate(()=>window.__events.some(event=>event[0]==='open')),false);
    await page.evaluate(()=>window.__failAdd=false);
    await page.getByRole('button',{name:/GBPUSD/}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.mobile-symbol').length===2);
    assert.deepEqual(await page.evaluate(()=>window.__events.find(event=>event[0]==='open')),['open','MWP:GBPUSD']);
    await nav.getByRole('button',{name:/更多/}).click();
    for(const name of ['系统消息','设置与账户','历史加载详情','历史数据容量','数据状态'])
      await page.getByText(name,{exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'历史加载详情'}).click();
    await page.getByRole('button',{name:'历史数据容量'}).click();
    assert.deepEqual(await page.evaluate(()=>window.__events.filter(event=>['history','capacity'].includes(event[0]))),[['history'],['capacity']]);
    console.log('mobile shell responsive navigation, workspace identity and save-before-open checks passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
