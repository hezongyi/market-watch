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

const files = ['series.js', 'price-format.js', 'indicators.js', 'native-indicator-results.js', 'indicator-coordinator.js', 'composite-display-batches.js', 'swing-sr-display.js', 'rolling-range-squeeze-display.js', 'nr-breakout-display.js', 'study-templates.js', 'indicator-picker.js', 'preferences.js', 'chart-style.js', 'chart-theme.js', 'chart-autosave.js',
  'workspaces.js', 'watchlists.js', 'chart-tab.js', 'symbol-flags.js', 'watchlist-layout.js', 'sync-coordinator.js', 'range-sync.js', 'viewports.js',
  'progressive-history.js', 'history-demand.js', 'native-reserve.js', 'native-navigation.js', 'bar-range-mapping.js', 'chart-account.js', 'sync-settings.js', 'chart-menu.js', 'drawing-projection.js', 'native-alert-price-lines.js', 'chart-alerts.js', 'native-alert-shell.js', 'native-notification-surface.js', 'alert-ui.js', 'chart-maximize.js', 'native-ui.js', 'native-indicator-dialog.js', 'data-center.js', 'chart-notices.js', 'chart-runtime.js'];
const scope = `
const listeners=[],timeouts=new Set(),intervals=new Set(),animations=new Set();
let scopeClosed=false;
function addEventListener(type,fn,options){globalThis.addEventListener(type,fn,options);listeners.push([type,fn,options]);}
function setTimeout(fn,delay,...args){const id=globalThis.setTimeout(()=>{timeouts.delete(id);if(!scopeClosed)fn(...args);},delay);timeouts.add(id);return id;}
function setInterval(fn,delay,...args){const id=globalThis.setInterval(()=>{if(!scopeClosed)fn(...args);},delay);intervals.add(id);return id;}
function requestAnimationFrame(fn){const id=globalThis.requestAnimationFrame(time=>{animations.delete(id);if(!scopeClosed)fn(time);});animations.add(id);return id;}
function clearTimeout(id){timeouts.delete(id);globalThis.clearTimeout(id);}
function clearInterval(id){intervals.delete(id);globalThis.clearInterval(id);}
function cancelAnimationFrame(id){animations.delete(id);globalThis.cancelAnimationFrame(id);}
function cleanupListeners(){
  scopeClosed=true;
  for(const [type,fn,options] of listeners){globalThis.removeEventListener(type,fn,options);if(type==='pagehide')fn(new Event('pagehide'));}
  for(const id of timeouts)globalThis.clearTimeout(id);
  for(const id of intervals)globalThis.clearInterval(id);
  for(const id of animations)globalThis.cancelAnimationFrame(id);
  listeners.length=0;timeouts.clear();intervals.clear();animations.clear();
}
`;
const source = `globalThis.MW_CHART_LIBRARY_PATH="/${libraryDirectory}/";
globalThis.MW_NATIVE_RESERVE_ENABLED=${process.env.NATIVE_RESERVE_ENABLED !== 'false'};
globalThis.MWChartAdapter={mount(container,application){
` + scope + files.map(name => readFileSync(new URL(name, import.meta.url), 'utf8')
  .replaceAll('globalThis.addEventListener(', 'addEventListener(')
  .replaceAll('globalThis.setInterval?.(', 'setInterval(')
  .replaceAll('globalThis.setInterval(', 'setInterval(')
  .replaceAll('globalThis.setTimeout(', 'setTimeout(')
  .replaceAll('globalThis.clearTimeout(', 'clearTimeout(')
  .replaceAll('globalThis.clearInterval?.(', 'clearInterval(')
  .replaceAll('globalThis.clearInterval(', 'clearInterval(')
  .replaceAll('globalThis.cancelAnimationFrame(', 'cancelAnimationFrame(')
  .replaceAll('globalThis.requestAnimationFrame(', 'requestAnimationFrame(')).join('\n;\n')+'\n}};\n';
const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
const filename = `chart.${digest}.js`;
writeFileSync(new URL(filename, import.meta.url), source);
writeFileSync(new URL('chart-assets.json', import.meta.url), JSON.stringify({script:filename,libraryDirectory}));
