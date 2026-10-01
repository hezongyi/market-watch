// Optional CPU sampling around the real browser acceptance driver. No routing
// or vendor modifications; profiles include code locations, never credentials.
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('../web/node_modules/@playwright/test');
const output = process.env.BOOT_CPU_OUTPUT;
if (!output) throw new Error('BOOT_CPU_OUTPUT is required');
const records = [], tasks = [];
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...values) => {
    const page = await newPage(...values);
    page.on('framenavigated', frame => {
      if (!frame.url().startsWith('https://127.0.0.1:15454/')) return;
      const task = (async () => {
        let session;
        const record = {};
        try {
          session = await page.context().newCDPSession(frame);
          await session.send('Profiler.enable');
          await session.send('Profiler.setSamplingInterval', {interval: 1000});
          record.start = await frame.evaluate(() => ({at: performance.now(), origin: performance.timeOrigin}));
          await session.send('Profiler.start');
          await frame.waitForFunction(() => typeof ready !== 'undefined' && ready, null, {timeout: 30000});
          const {profile} = await session.send('Profiler.stop');
          record.marks = await frame.evaluate(() => bootTrace);
          const getBars = record.marks.find(mark => mark.name === 'getBars');
          const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
          const totals = new Map();
          let elapsed = 0;
          for (let i = 0; i < profile.samples.length; i++) {
            elapsed += profile.timeDeltas[i];
            if (getBars && record.start.at + elapsed / 1000 > getBars.at) break;
            const call = nodes.get(profile.samples[i]);
            const key = JSON.stringify(call);
            totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[i] / 1000);
          }
          record.before_getBars_cpu = [...totals].map(([key, ms]) => ({...JSON.parse(key), sampled_ms: Math.round(ms * 100) / 100})).sort((a, b) => b.sampled_ms - a.sampled_ms);
          record.profile = profile;
        } catch (error) {
          record.error = String(error);
        } finally {
          records.push(record);
          fs.writeFileSync(output, JSON.stringify({records}, null, 2));
          await session?.detach().catch(() => {});
        }
      })();
      tasks.push(task);
    });
    return page;
  };
  const close = browser.close.bind(browser);
  browser.close = async () => {
    await Promise.allSettled(tasks);
    return close();
  };
  return browser;
};
require(path.resolve(__dirname, '../web/tests/advanced-provider-first-screen.browser.cjs'));
