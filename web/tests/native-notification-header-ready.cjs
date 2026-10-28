const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function fixture({ buttonError } = {}) {
  let releaseHeader, rejectHeader, headerLoaded = false;
  const header = new Promise((resolve, reject) => {
    releaseHeader = () => { headerLoaded = true; resolve(); };
    rejectHeader = reject;
  });
  const calls = { shell: 0, buttons: 0, removed: 0, destroyed: 0 };
  const modules = {
    779474: {}, 590263: { createReactRoot() {} },
    491617: { Dialog() {} }, 569716: { NavButton() {} },
    357723: { DialogSearch() {} }, 51061: { ToolbarIconButton() {} },
    412377: { popupDialog: 'popup' }, 421859: { scrollContainer: 'scroll' },
  };
  const doc = {
    defaultView: { webpackChunktradingview: { push(entry) { entry[2](id => modules[id]); } } },
    createElement: () => ({ remove() {} }), head: { append() {} },
  };
  const widget = {
    headerReady: () => header,
    createButton() {
      calls.buttons++;
      if (!headerLoaded) throw Error('Cannot create button: header widget is not ready or is not loaded - use `headerReady` to wait until header is ready');
      if (buttonError) throw buttonError;
      return { ownerDocument: doc };
    },
    removeButton() { calls.removed++; },
  };
  const sandbox = vm.createContext({
    crypto: webcrypto,
    TradingView: { version: () => 'v31.1.0 6b804c486857f27920cf761aa7eb6e29d9bb6362' },
    nativeAlertShell: async () => { calls.shell++; return { destroy() { calls.destroyed++; } }; },
    nativeAlertChunks: async () => {},
  });
  vm.runInContext(readFileSync(resolve(__dirname, '../../advanced-host/native-notification-surface.js'), 'utf8'), sandbox);
  return { calls, releaseHeader, rejectHeader, attach: () => sandbox.nativeNotificationSurface(widget, () => {}) };
}

test('notification surface waits for the actual header before acquiring its shell or creating a button', async () => {
  const f = fixture();
  const pending = f.attach().then(value => ({ value }), error => ({ error }));
  await new Promise(setImmediate);
  assert.equal(f.calls.buttons, 0, 'Notification attachment must not race headerReady');
  assert.equal(f.calls.shell, 0, 'Do not acquire a native shell while the header is unavailable');
  f.releaseHeader();
  const result = await pending;
  assert.ifError(result.error);
  assert.equal(f.calls.buttons, 1);
  assert.equal(f.calls.removed, 1);
  result.value.destroy();
  assert.equal(f.calls.destroyed, 1);
});

test('header failure propagates without leaving a partially attached shell', async () => {
  const f = fixture();
  const pending = f.attach();
  const rejected = assert.rejects(pending, /header removed/);
  f.rejectHeader(Error('header removed'));
  await rejected;
  assert.equal(f.calls.shell, 0);
  assert.equal(f.calls.buttons, 0);
});

test('a button failure after header readiness releases the acquired native shell', async () => {
  const f = fixture({ buttonError: Error('chart disposed during attachment') });
  f.releaseHeader();
  await assert.rejects(f.attach(), /chart disposed during attachment/);
  assert.equal(f.calls.destroyed, 1);
});
