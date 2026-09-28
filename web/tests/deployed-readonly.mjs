// Authenticate and inspect deployed pages without creating watches or sending alerts.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const baseURL = process.env.TEST_BASE_URL;
if (!baseURL) throw new Error('TEST_BASE_URL is required');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const failedResponses = [];
let loggedIn = false;
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  const path = new URL(response.url()).pathname;
  if (path === '/api/login' && response.ok()) loggedIn = true;
  if (!loggedIn && path === '/api/session' && response.status() === 401) return;
  if (response.status() >= 400) failedResponses.push({ status: response.status(), path });
});
try {
  await page.goto(baseURL);
  await page.getByLabel('管理员密码').fill(JSON.parse(fs.readFileSync('../artifacts/local-credentials.json', 'utf8')).password);
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('heading', { name: '让机会，主动找到你。' }).waitFor();
  const cookie = (await context.cookies()).find(c => c.name === 'session');
  if (new URL(baseURL).protocol === 'https:' && !cookie?.secure) throw new Error('HTTPS session lacks Secure cookie');
  await page.screenshot({ path: '../artifacts/deployed-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '历史演练' }).click();
  await page.getByRole('heading', { name: '回到当时，验证你的判断。' }).waitFor();
  await page.getByRole('link', { name: '提醒与设置' }).click();
  await page.getByRole('heading', { name: '让重要提醒，真正被听见。' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '让重要提醒，真正被听见。' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: '行情与监控' }).click();
  await page.getByRole('heading', { name: '让机会，主动找到你。' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.screenshot({ path: '../artifacts/deployed-mobile.png', fullPage: true });
  const result = { baseURL, errors, failedResponses, overflow, secureCookie: cookie?.secure, checkedAt: new Date().toISOString() };
  fs.writeFileSync('../artifacts/deployed-browser-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length || failedResponses.length || overflow) process.exitCode = 1;
} finally {
  await browser.close();
}
