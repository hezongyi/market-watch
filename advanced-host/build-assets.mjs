import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, cpSync, readdirSync, rmSync} from 'node:fs';

// Give all private library assets a URL derived from the patched bytes.
const bundle = readFileSync(new URL('charting_library/bundles/library.e2f8b3a016c9e1a0b7a5.js', import.meta.url));
const toolset = readFileSync(new URL('charting_library/bundles/restricted-toolset.4fbfc823d8551bbb3e53.js', import.meta.url));
const libraryVersion = createHash('sha256').update(bundle).update(toolset).digest('hex').slice(0,16);
const libraryDirectory = `charting_library_${libraryVersion}`;
for (const name of readdirSync(new URL('.',import.meta.url)))
  if (/^charting_library_[a-f0-9]{16}$/.test(name) && name !== libraryDirectory)
    rmSync(new URL(name,import.meta.url), {recursive:true});
cpSync(new URL('charting_library',import.meta.url), new URL(libraryDirectory,import.meta.url), {recursive:true});

const files = ['series.js', 'price-format.js', 'indicators.js', 'swing-sr-display.js', 'study-templates.js', 'indicator-picker.js', 'preferences.js', 'chart-style.js', 'chart-theme.js', 'chart-autosave.js',
  'workspaces.js', 'watchlists.js', 'sync-coordinator.js', 'range-sync.js', 'viewports.js',
  'progressive-history.js', 'history-demand.js', 'native-reserve.js', 'native-navigation.js', 'bar-range-mapping.js', 'chart-account.js', 'sync-settings.js', 'chart-menu.js', 'drawing-projection.js', 'drawing-visibility.js', 'chart-alerts.js', 'native-alert-shell.js', 'alert-ui.js', 'chart-maximize.js', 'native-ui.js', 'native-indicator-dialog.js', 'data-center.js', 'bridge.js'];
const source = `globalThis.MW_CHART_LIBRARY_PATH="/${libraryDirectory}/";\nglobalThis.MW_NATIVE_RESERVE_ENABLED=${process.env.NATIVE_RESERVE_ENABLED !== 'false'};\n` +
  files.map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n;\n');
const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
const filename = `host.${digest}.js`;
writeFileSync(new URL(filename, import.meta.url), source);
let html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
html = html.replace(/    <script defer src="\/(?!charting_library(?:_[a-f0-9]+)?\/)[^"]+\.js"><\/script>\n/g, '');
html = html.replace(/\/charting_library(?:_[a-f0-9]+)?\/charting_library.js/g, `/${libraryDirectory}/charting_library.js`);
html = html.replace('  </body>', `    <script defer src="/${filename}"></script>\n  </body>`);
writeFileSync(new URL('index.html', import.meta.url), html);
