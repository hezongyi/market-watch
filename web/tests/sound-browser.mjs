// Alert data and SSE are local fixtures; no real watch or notification is created.
import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let signals=[];
await page.addInitScript(()=>{
 window.__soundStarts=0;
 const NativeAudio=window.AudioContext;
 window.AudioContext=class extends NativeAudio {
  constructor(...args){super(...args);window.__audio=this;}
  createOscillator(){const osc=super.createOscillator();const start=osc.start.bind(osc);osc.start=(...args)=>{window.__soundStarts++;start(...args)};return osc;}
 };
 window.EventSource=class {constructor(){window.__events=this;}close(){}};
});
await page.route('**/api/signals',route=>route.fulfill({json:signals}));
await page.route('**/api/notification-tests',route=>route.abort());
await page.route('**/api/watches',route=>route.request().method()==='GET'?route.continue():route.abort());
const signal=id=>({id,instrument_id:'BTCUSDT',direction:'buy',reason:'浏览器声音验收',price:'10',threshold:'9',occurred_at:Date.now(),notification_id:id,notification_status:'server_accepted',retry_available:false,device_delivery:'unknown',ack_at:null});
async function refresh(){
 const received=page.waitForResponse(r=>r.url().endsWith('/api/signals'));
 await page.evaluate(()=>window.__events.onmessage({data:'fixture'}));
 await received;
}
try{
 await page.goto(process.env.TEST_BASE_URL||'http://127.0.0.1:5173');
 await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../artifacts/local-credentials.json')).password);
 await page.getByRole('button',{name:'登录工作台'}).click();
 await page.getByRole('button',{name:'开启网页声音'}).waitFor();
 await page.getByRole('link',{name:'信号中心'}).click();
 signals=[signal('sound-fixture-a')];await refresh();
 await page.getByRole('heading',{name:'BTCUSDT · 浏览器声音验收'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__soundStarts),0);
 await page.getByRole('button',{name:'开启网页声音'}).click();
 await page.waitForFunction(()=>window.__audio.state==='running');
 assert.equal(await page.evaluate(()=>window.__soundStarts),0);
 signals=[...signals,signal('sound-fixture-b')];await refresh();
 await page.waitForFunction(()=>window.__soundStarts===1);
 await refresh();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>window.__soundStarts),1);
 await page.getByRole('button',{name:'网页声音已开'}).click();
 signals=[...signals,signal('sound-fixture-c')];await refresh();
 await page.getByRole('heading',{name:'BTCUSDT · 浏览器声音验收'}).nth(2).waitFor();
 assert.equal(await page.evaluate(()=>window.__soundStarts),1);
 await page.getByRole('link',{name:'提醒与设置'}).click();
 await page.getByRole('button',{name:'试听网页声音'}).click();
 await page.waitForFunction(()=>window.__soundStarts===2);
 await page.getByText('试听已播放；若未听到，请检查设备音量和站点声音权限。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'开启网页声音',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:'../artifacts/sound-preview-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['disabled-no-tone','user-gesture-audio-running','new-signal-tone','duplicate-no-tone','disabled-again-no-tone','preview-tone-without-enabling-alerts','mobile-layout'],realNotificationsSent:0}));
}finally{await browser.close();}
