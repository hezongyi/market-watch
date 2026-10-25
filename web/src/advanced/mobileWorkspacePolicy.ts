// UI session policy, not an account/role system. Call once on route mount.
export function initialMobileSession(coarsePointer: boolean, width: number) {
  return coarsePointer || width < 768;
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export function mobileAlertRequestAllowed(path: string, body: unknown) {
  if (body === undefined) return path === '/chart-alerts' || path === '/chart-alerts/events' ||
    new RegExp(`^/chart-alerts/${uuid}$`).test(path);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (path === '/chart-alerts/capabilities' || new RegExp(`^/notifications/${uuid}/ack$`).test(path)) return true;
  return new RegExp(`^/chart-alerts/${uuid}/lifecycle$`).test(path) &&
    ['pause', 'resume'].includes((body as {action?: string}).action || '');
}

const datasetId = /^[a-f0-9]{64}$/;
const versionId = new RegExp(`^${uuid}$`);
// Audited history_api/data_center/platform_catalog/live_api reads only. No URL
// normalisation: traversal, encoded path segments and management subpaths fail.
export function mobileDataRequestAllowed(path: unknown, body: unknown) {
  if (body !== undefined || typeof path !== 'string' || path.length > 4000 ||
      !/^\/market-data\/[A-Za-z0-9/_-]+(?:\?[^#]*)?$/.test(path)) return false;
  const [pathname, query = ''] = path.split('?');
  if (path.indexOf('?') !== path.lastIndexOf('?') || query.length > 3000) return false;
  const page = ['page', 'page_size'];
  let keys: string[];
  if (['/market-data/sources', '/market-data/live/status'].includes(pathname)) keys = [];
  else if (pathname === '/market-data/center/platform') keys = ['query', 'source', 'asset_class', ...page];
  else if (pathname === '/market-data/center/datasets') keys = ['query', 'source', 'asset_class', 'calendar', 'status', ...page];
  else if (/^\/market-data\/center\/datasets\/[a-f0-9]{64}$/.test(pathname)) keys = [];
  else if (pathname === '/market-data/versions') keys = ['dataset_id'];
  else if (new RegExp(`^/market-data/versions/${uuid}/artifacts$`).test(pathname)) keys = [];
  else if (new RegExp(`^/market-data/versions/${uuid}/coverage$`).test(pathname)) keys = page;
  else if (pathname === '/market-data/center/calendars') keys = ['source', 'query'];
  else if (pathname === '/market-data/center/task-feed') keys = ['dataset_id', 'query', 'source', 'status', 'page_size', 'snapshot', 'before', 'ids'];
  else return false;
  const params = new URLSearchParams(query), seen = new Set<string>();
  for (const part of query ? query.split('&') : []) {
    const separator = part.indexOf('=');
    if (separator <= 0) return false;
    const key = part.slice(0, separator), rawValue = part.slice(separator + 1);
    let value: string;
    try { value = decodeURIComponent(rawValue.replace(/\+/g, ' ')); }
    catch { return false; }
    if (!keys.includes(key) || seen.has(key) || value.length > 1000) return false;
    seen.add(key);
    if (key === 'dataset_id' && !datasetId.test(value)) return false;
    if (['page', 'page_size', 'snapshot'].includes(key) &&
        (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
         Number(value) < (key === 'snapshot' ? 0 : 1) || key === 'page_size' && Number(value) > 100)) return false;
    if (key === 'ids' && (value.split(',').length > 100 || !value.split(',').every(id => versionId.test(id)))) return false;
    if (key === 'before') {
      const [stamp, id, extra] = value.split(':');
      if (extra !== undefined || !/^\d+$/.test(stamp) || !Number.isSafeInteger(Number(stamp)) || !versionId.test(id)) return false;
    }
  }
  return pathname !== '/market-data/versions' || params.has('dataset_id');
}

export const mobileWatchlistKey = JSON.stringify(['setting', 'mw.watchlists.v1', '']);
const mobileSymbolFlagsKey = JSON.stringify(['setting', 'mw.symbol-flags.v1', '']);
type DraftIdentity = {key?: string; version?: string; storageKey?: string; kind?: string; name?: string; tool?: string; operation?: string};
function mobileSettingKey(value: any) {
  return mobileWatchlistSetting(value) ? mobileWatchlistKey : mobileSymbolFlagsSetting(value) ? mobileSymbolFlagsKey : null;
}
function validMobilePreference(value:any) {
  if (mobileWatchlistSetting(value)) {
    const content=value.content?.value;
    return !!content && typeof content==='object' && !Array.isArray(content) && Array.isArray(content.lists) && content.lists.length<=100 &&
      content.lists.every((list:any)=>list && typeof list.id==='string' && list.id.length>0 && list.id.length<=128 && typeof list.title==='string' && list.title.length<=128 && Array.isArray(list.symbols) && list.symbols.length<=2000 && list.symbols.every((ticker:any)=>typeof ticker==='string' && ticker.length<=150)) &&
      (content.active===undefined || typeof content.active==='string' && content.active.length<=128);
  }
  if (mobileSymbolFlagsSetting(value)) {
    const content=value.content?.value;
    return content?.version===1 && content.flags && typeof content.flags==='object' && !Array.isArray(content.flags) &&
      Object.keys(content.flags).length<=2000 && Object.entries(content.flags).every(([ticker,color])=>ticker.length<=150 && ['red','blue','green','yellow','purple','cyan','pink'].includes(color as string));
  }
  return false;
}
export function mobileWatchlistSetting(value: any) {
  return value?.kind === 'setting' && value.name === 'mw.watchlists.v1' && (value.tool === undefined || value.tool === '');
}
export function mobileSymbolFlagsSetting(value: any) {
  return value?.kind === 'setting' && value.name === 'mw.symbol-flags.v1' && (value.tool === undefined || value.tool === '');
}
// For drop/check/failed, trust the stored record, never the renderer's claimed
// key. localDrafts then performs its existing writer/version checks.
export function mobilePreferenceRequestAllowed(op: string, args: any, drafts: DraftIdentity[]) {
  if (op === 'read') return args === undefined || args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
  if (op === 'save') return !!(args && typeof args === 'object' && !Array.isArray(args) &&
    validMobilePreference(args) && args.content && typeof args.content === 'object' &&
    Number.isSafeInteger(args.revision) && args.revision >= 0 && JSON.stringify(args).length <= 1_100_000);
  if (!args || ![mobileWatchlistKey,mobileSymbolFlagsKey].includes(args.key) || typeof args.version !== 'string') return false;
  if (op === 'draftWrite') return !!mobileSettingKey(args) && args.key === mobileSettingKey(args) && args.operation === 'save' &&
    args.storageKey === undefined && typeof args.version === 'string' && args.version.length <= 128 &&
    Object.hasOwn(args, 'value') && JSON.stringify(args).length <= 1_100_000;
  if (!['draftCheck', 'draftDrop', 'draftFailed'].includes(op)) return false;
  const stored = drafts.find(draft => draft.key === args.key && draft.version === args.version && draft.storageKey === args.storageKey);
  return !!stored && mobileSettingKey(stored) === stored.key && stored.key === args.key && stored.operation === 'save';
}

export function mobileRecoverablePreferenceDrafts<T extends DraftIdentity>(drafts: T[]) {
  return drafts.filter(draft => mobilePreferenceRequestAllowed('draftCheck', draft, drafts));
}
