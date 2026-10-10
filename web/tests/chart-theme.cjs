const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../advanced-host/chart-theme.js'), 'utf8'), context);
const setting = (name, value) => ({ kind: 'setting', name, content: { value } });
const chart = (background, textColor) => ({ chartProperties: { paneProperties: { background }, scalesProperties: { textColor } } });
let checks = 0;
function check(actual, expected) { assert.equal(actual, expected); checks++; }
check(context.chartInitialTheme([], {}, {}), 'Dark');
check(context.chartInitialTheme([setting('mw.theme', 'LIGHT')], { theme: 'Dark' }, { _mwTheme: 'Dark' }), 'Light');
check(context.chartInitialTheme([setting('mw.theme', {}), setting('current_theme.name', 'dark')], { theme: 'Light' }, {}), 'Dark');
check(context.chartInitialTheme([], { theme: 'Dark' }, { _mwTheme: 'Light' }), 'Light');
check(context.chartInitialTheme([], { theme: 'light' }, {}), 'Light');
check(context.chartThemeName('invalid'), undefined);
(async () => {
  const cases = [
    [{ _mwTheme: 'Dark' }, 'Dark', [chart('#ffffff', '#0F0F0F')], false], // Explicit same-theme customization.
    [{ _mwTheme: 'Light' }, 'Dark', [chart('#182736', '#0F0F0F')], true],
    [{}, 'Dark', [chart('#ffffff', '#0F0F0F')], true],
    [{}, 'Light', [chart('#0F0F0F', '#B8B8B8')], true],
    [{}, 'Dark', [chart('#0F0F0F', '#B8B8B8')], false],
    [{}, 'Dark', [chart('#182736', '#0F0F0F')], false], // Unmarked custom background.
    [{}, 'Light', [chart('#ffffff', '#0F0F0F'), chart('#0F0F0F', '#B8B8B8')], true],
    [{}, 'Dark', [], false],
  ];
  for (const [state, theme, charts, changes] of cases) {
    const calls = [];
    await context.restoreChartTheme({ save: callback => callback({ charts }),
      changeTheme: async (value, options) => calls.push({ value, options }) }, state, theme);
    check(calls.length, changes ? 1 : 0);
    if (changes) { check(calls[0].value, theme); check(calls[0].options.disableUndo, true); }
  }
  console.log(`${checks} theme selection, legacy/multichart repair and custom-style preservation checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
