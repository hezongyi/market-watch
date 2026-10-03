import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';

const files = ['series.js', 'indicators.js', 'preferences.js', 'chart-style.js', 'chart-autosave.js',
  'workspaces.js', 'watchlists.js', 'range-sync.js', 'viewports.js',
  'progressive-history.js', 'history-demand.js', 'native-reserve.js', 'chart-account.js', 'chart-menu.js', 'bridge.js'];
const source = `globalThis.MW_NATIVE_RESERVE_ENABLED=${process.env.NATIVE_RESERVE_ENABLED !== 'false'};\n` +
  files.map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n;\n');
const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
const filename = `host.${digest}.js`;
writeFileSync(new URL(filename, import.meta.url), source);
let html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
html = html.replace(/    <script defer src="\/(?!charting_library\/)[^"]+\.js"><\/script>\n/g, '');
html = html.replace('  </body>', `    <script defer src="/${filename}"></script>\n  </body>`);
writeFileSync(new URL('index.html', import.meta.url), html);
