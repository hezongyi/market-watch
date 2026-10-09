const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('@playwright/test');
const root=path.resolve(__dirname,'../..'),art=path.join(root,'artifacts/data-center');
const base=new URL(process.env.MW_DATA_CENTER_URL||'https://192.168.7.232:19943').origin;
const chartOrigin=new URL(process.env.MW_DATA_CENTER_CHART_ORIGIN||'https://192.168.7.232:19944').origin;
const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const launch=()=>chromium.launch({executablePath,args:['--no-sandbox']});
const frames=p=>({host:()=>p.frames().find(f=>f.url().startsWith(chartOrigin+'/?')),native:()=>p.frames().find(f=>f.url().startsWith('blob:')),center:()=>p.frames().find(f=>f.url().startsWith(base+'/chart-data-center?'))});
const login=async p=>{await p.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync(path.join(art,'login.json'))).password);await p.getByRole('button',{name:'登录工作台'}).click();await p.waitForFunction(()=>!document.querySelector('input[type=password]'),null,{timeout:30000})};
const localNativeAssets=async p=>{
 await p.route("**/assets/index-*.js",r=>{const dir=path.join(root,"web/dist/assets");const file=fs.readdirSync(dir).find(n=>/^index-.*\.js$/.test(n));return r.fulfill({path:path.join(dir,file),contentType:"application/javascript"});});
 await p.route("**/host.*.js",async r=>{const original=await(await r.fetch()).text();const files=eval(fs.readFileSync(path.join(root,"advanced-host/build-assets.mjs"),"utf8").match(/const files = (\[[\s\S]*?\]);/)[1]);await r.fulfill({contentType:"application/javascript",body:original.split("\n").slice(0,2).join("\n")+"\n"+files.map(n=>fs.readFileSync(path.join(root,"advanced-host",n),"utf8")).join("\n;\n")});});
 for(const ext of ["js","css"]) await p.route("**/data-center-native."+ext,r=>r.fulfill({path:path.join(root,"web/dist/data-center-native."+ext),contentType:ext==="js"?"application/javascript":"text/css"}));
};
module.exports={localNativeAssets,root,art,base,chartOrigin,launch,frames,login};
