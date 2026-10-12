const {chromium,expect}=require('@playwright/test');
const fs=require('node:fs');
async function product(options={}){
  const {initScript,...pageOptions}=options;
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',args:['--no-sandbox']});
  try {
  const page=await browser.newPage({viewport:{width:1600,height:1000},...pageOptions}),errors=[];
  if(initScript)await page.addInitScript(initScript);
  page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(e.stack));
  await page.goto('http://localhost:19997/');
  await page.getByLabel('管理员密码').fill(fs.readFileSync('/tmp/mw-pro-charts-20261011/login-password','utf8').trim());
  const login=page.waitForResponse(r=>r.url().endsWith('/api/login'));
  await page.getByRole('button',{name:'登录工作台'}).click();expect((await login).status()).toBe(200);
  await page.waitForTimeout(300);await page.goto('http://localhost:19997/advanced-charts');
  await page.locator('iframe[title="专业图表工作区"]').waitFor();
  await expect.poll(()=>page.frames().some(f=>f.url().startsWith('http://localhost:19998/?'))).toBe(true);
  const host=page.frames().find(f=>f.url().startsWith('http://localhost:19998/?'));
  await host.waitForFunction(()=>typeof ready!=='undefined'&&ready&&!loading&&widget.activeChart().dataReady(),null,{timeout:60000});
  const ui=host.childFrames()[0];
  const center=ui.locator('[data-name="mw-data-center-dialog"]');
  const open=async()=>{await ui.getByRole('button',{name:'数据中心',exact:true}).click();await expect(center).toBeVisible();};
  const choose=async(label,option)=>{
    await center.getByRole('button',{name:label,exact:true}).click();
    const item=typeof option==='string'?ui.getByRole('option',{name:option,exact:true}):ui.getByRole('option').filter({hasText:option});
    await expect(item.first()).toBeVisible();await item.first().click();
  };
  return {browser,page,host,ui,center,open,choose,errors,expect};
  } catch(error) {await browser.close();throw error;}
}
module.exports={product};
