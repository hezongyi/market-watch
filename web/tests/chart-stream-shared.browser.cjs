// Real EventSource transport for supplier and composite charts on one page.
// Synthetic local HTTP server; no supplier, account or deployed app is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const ts = require('typescript');
const {chromium} = require('@playwright/test');

(async () => {
  const requests = [], sockets = new Set();
  let connections = 0;
  const module = ts.transpileModule(fs.readFileSync('src/advanced/providerSubscriptions.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/charts/stream/events?')) {
      connections++;
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
      res.write('retry: 100\n: connected\n\n');
      sockets.add(res);
      req.on('close', () => sockets.delete(res));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({path: req.url, body: JSON.parse(body)});
      res.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/html'}).end('<!doctype html><title>Chart stream fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const waitFor = async predicate => {
    const until = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < until, 'transport condition timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const send = event => {for (const socket of sockets) socket.write('data: ' + JSON.stringify(event) + '\n\n');};
  const subscribe = (listener, generation, kind, instrument) => page.evaluate(
    args => transport.subscribe(args), {client: 'mixed-page', listener, generation, kind: 'bars',
      query: {instrument, series_kind: kind, timeframe: 'M1'}});
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.addScriptTag({content: 'globalThis.exports = {};\n' + module});
    await page.evaluate(() => {
      globalThis.received = [];
      globalThis.transport = exports.providerSubscriptions(async (path, body) => {
        const response = await fetch('/api' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        if (!response.ok) throw Error('Registration failed');
        return response.json();
      }, client => new EventSource('/api/charts/stream/events?client=' + client),
      event => received.push(event), error => {throw error;});
    });
    await subscribe('supplier', 1, 'provider', 'OANDA:EUR_USD');
    await subscribe('self-built', 1, 'composite', 'a'.repeat(64));
    await waitFor(() => sockets.size === 1 && requests.filter(r => r.path.endsWith('/subscribe')).length >= 2);
    assert.equal(connections, 1, 'both chart kinds share one EventSource');
    for (const listener of ['supplier', 'self-built']) send({listener, generation: 1, sequence: 1, type: 'bars'});
    await page.waitForFunction(() => received.length === 2);

    // Close the real socket. Native reconnect must preserve both cursors.
    for (const socket of sockets) socket.end();
    await waitFor(() => connections === 2 && ['supplier', 'self-built'].every(listener =>
      requests.some(r => r.body.listener === listener && r.body.sequence === 1)));
    for (const listener of ['supplier', 'self-built']) send({listener, generation: 1, sequence: 2, type: 'reset', reason: 'history_changed'});
    await page.waitForFunction(() => received.filter(e => e.type === 'reset').length === 2);

    // A rapid switch fences the prior supplier generation on the shared socket.
    await subscribe('supplier', 2, 'provider', 'OANDA:XAU_USD');
    send({listener: 'supplier', generation: 1, sequence: 99, type: 'bars'});
    send({listener: 'supplier', generation: 2, sequence: 1, type: 'bars'});
    await page.waitForFunction(() => received.some(e => e.listener === 'supplier' && e.generation === 2));
    assert.equal(await page.evaluate(() => received.some(e => e.sequence === 99)), false);
    await page.evaluate(() => transport.unsubscribe({client: 'mixed-page', listener: 'supplier', generation: 2}));
    assert.equal(sockets.size, 1, 'canceling one chart preserves the other chart connection');
    send({listener: 'supplier', generation: 2, sequence: 2, type: 'bars'});
    send({listener: 'self-built', generation: 1, sequence: 3, type: 'bars'});
    await page.waitForFunction(() => received.some(e => e.listener === 'self-built' && e.sequence === 3));
    assert.equal(await page.evaluate(() => received.some(e => e.listener === 'supplier' && e.sequence === 2 && e.type === 'bars')), false);
    await page.evaluate(() => transport.clear());
    await waitFor(() => sockets.size === 0);
    assert.ok(requests.every(r => r.path.startsWith('/api/charts/stream/')));
    assert.deepEqual(failures, []);
    console.log('PASS: one real SSE for supplier/composite; reconnect, reset, switch and cancellation');
  } finally {
    await browser.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
