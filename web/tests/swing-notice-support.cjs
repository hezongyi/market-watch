// Shared native-browser harness. Local fixtures never write to the acceptance database.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium, expect} = require('@playwright/test');
const root = path.resolve(__dirname, '../..');
function configuration() {
  for (const key of ['MW_TEST_BASE_URL', 'MW_TEST_CHART_URL', 'MW_TEST_CREDENTIALS_FILE', 'MW_TEST_ARTIFACT_DIR'])
    if (!process.env[key]) throw Error(key + ' is required; no implicit instance target');
  const base = new URL(process.env.MW_TEST_BASE_URL), chart = new URL(process.env.MW_TEST_CHART_URL);
  if (base.protocol !== 'https:' || chart.protocol !== 'https:') throw Error('HTTPS origins required');
  const credentials = JSON.parse(fs.readFileSync(process.env.MW_TEST_CREDENTIALS_FILE));
  if (!credentials.login_password) throw Error('credentials.login_password is required');
  const output = path.resolve(process.env.MW_TEST_ARTIFACT_DIR);
  fs.mkdirSync(output, {recursive: true});
  return {base: base.origin, chart: chart.origin, password: credentials.login_password, output};
}
async function fixtureServer() {
  execFileSync(path.join(root, '.venv/bin/python'), [path.join(__dirname, 'fixtures/swing-notice-feed.py')], {cwd: root});
  execFileSync(process.execPath, ['scripts/build-alert-ui.mjs', '../artifacts/swing-notice-ui'], {cwd: path.join(root, 'web')});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    try {
      let filename = decodeURIComponent(url.pathname);
      if (filename === '/alert-ui.css') filename = '/artifacts/swing-notice-ui/alert-ui.css';
      if (filename === '/baseline-indicators.js' || filename === '/baseline-display.js') {
        const original = filename.includes('indicators') ? 'indicators.js' : 'swing-sr-display.js';
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(execFileSync('git', ['show', 'v1.28.0:advanced-host/' + original], {cwd: root}));
      }
      if (filename === '/fixture.html') {
        let body = fs.readFileSync(path.join(__dirname, 'fixtures/swing-price-presentation.html'), 'utf8');
        body = body.replaceAll('../../../advanced-host/', '/advanced-host/').replaceAll('../../../artifacts/', '/artifacts/');
        if (url.searchParams.has('baseline')) body = body.replace('/advanced-host/indicators.js', '/baseline-indicators.js').replace('/advanced-host/swing-sr-display.js', '/baseline-display.js');
        res.setHeader('Content-Type', 'text/html');return res.end(body);
      }
      const file = path.resolve(root, '.' + filename);
      if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      fs.createReadStream(file).on('error', () => {res.writeHead(404);res.end();}).pipe(res);
    } catch (error) {res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(resolve => server.close(resolve))};
}
async function nativePage(browser, url) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await page.goto(url);
  await page.waitForFunction(() => ready && widget.activeChart().dataReady(), null, {timeout: 60000});
  await page.waitForFunction(() => widget.activeChart().getAllShapes().length === 2, null, {timeout: 30000});
  return page;
}
async function application(browser, config) {
  const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 900}});
  const writes = [];
  await context.route('**/api/advanced-charts/**', async route => {
    const r = route.request(), url = new URL(r.url());
    if (['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || url.pathname.endsWith('/preferences/migrate')) return route.continue();
    writes.push(url.pathname);
    if (url.pathname.endsWith('/preferences/save')) {
      const body = r.postDataJSON();return route.fulfill({json: {...body, id:'inspection-only', revision: body.revision + 1, updated_at: Date.now()}});
    }
    return route.fulfill({status:409, json:{detail:'Read-only task inspection'}});
  });
  const page = await context.newPage();
  await page.goto(config.base + '/advanced-charts/mw75-real');
  await page.getByLabel('管理员密码').fill(config.password);
  await page.locator('button.auth-submit').click();
  await expect.poll(() => page.frames().some(f => f.url().startsWith(config.chart) && f.url().includes('/?')), {timeout:90000}).toBe(true);
  const host = page.frames().find(f => f.url().startsWith(config.chart) && f.url().includes('/?'));
  await host.waitForFunction(() => {try {return typeof widget !== 'undefined' && widget.activeChart().dataReady();} catch {return false;}}, null, {timeout:120000});
  await expect.poll(() => page.frames().some(f=>f.url().startsWith('blob:')), {timeout:60000}).toBe(true);
  return {context, page, host, native:()=>page.frames().find(f=>f.url().startsWith('blob:')), writes};
}
module.exports = {root, configuration, fixtureServer, nativePage, application, chromium, expect, fs, path};
