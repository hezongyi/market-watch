import {chromium} from '@playwright/test';import fs from 'node:fs';
const browser=await chromium.launch({executablePath:'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',headless:true,args:['--no-sandbox']});
const p=await browser.newPage({viewport:{width:1440,height:1000}});await p.goto('http://127.0.0.1:5173');await p.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../artifacts/local-credentials.json')).password);await p.getByRole('button',{name:'登录工作台'}).click();
await p.waitForFunction(()=>document.querySelector('.chart canvas')?.width>100);
await p.waitForFunction(()=>{const c=document.querySelector('.chart canvas');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]<150&&d[i+1]<170&&d[i+2]<150&&d[i+3]>0)n++;return n>100;},{timeout:5000});
await p.screenshot({path:'../artifacts/chart-checked.png',fullPage:true});console.log('chart contains rendered non-background pixels');await browser.close();
