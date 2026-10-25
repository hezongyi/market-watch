const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const {buildSync} = require('esbuild');
const output = buildSync({entryPoints: [path.resolve(__dirname, '../src/advanced/mobileWorkspacePolicy.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'}).outputFiles[0].text;
const moduleObject = {exports: {}};
vm.runInNewContext(output, {module: moduleObject, exports: moduleObject.exports, URLSearchParams});
const {initialMobileSession, mobileAlertRequestAllowed, mobileDataRequestAllowed,
  mobileWatchlistKey, mobilePreferenceRequestAllowed, mobileSymbolFlagsSetting, mobileRecoverablePreferenceDrafts} = moduleObject.exports;
const id = '1a9c47d0-1452-4018-a58d-eacbb38d9bd7';
test('initial coarse tablet, narrow fine desktop, wide desktop and boundary policy', () => {
  assert.equal(initialMobileSession(true, 1200), true);
  assert.equal(initialMobileSession(false, 767), true);
  assert.equal(initialMobileSession(false, 768), false);
  assert.equal(initialMobileSession(false, 1440), false);
  const source = fs.readFileSync(path.resolve(__dirname, '../src/advanced/AdvancedWorkspace.tsx'), 'utf8');
  assert.match(source, /const \[mobile\] = useState\(\(\) => initialMobileSession/);
});
test('data status accepts audited reads, real dataset hashes/UUIDs, bounded paging and task cursor', () => {
  const dataset = 'a'.repeat(64);
  for (const p of ['/market-data/sources', '/market-data/live/status',
    '/market-data/center/platform?query=EURUSD&source=oanda&asset_class=forex&page=2&page_size=100',
    '/market-data/center/datasets?query=EURUSD&status=available&calendar=&page=1&page_size=25',
    `/market-data/center/datasets/${dataset}`, `/market-data/versions?dataset_id=${dataset}`,
    `/market-data/versions/${id}/artifacts`, `/market-data/versions/${id}/coverage?page_size=25`,
    '/market-data/center/calendars?source=oanda&query=FX',
    `/market-data/center/task-feed?dataset_id=${dataset}&snapshot=100&before=50%3A${id}&page_size=25`,
    `/market-data/center/task-feed?ids=${id}`]) assert.equal(mobileDataRequestAllowed(p, undefined), true, p);
});
test('data status rejects writes, management reads, path/URL escapes and invalid filters before API calls', async () => {
  let calls = 0;
  const call = async (p,b) => {if (!mobileDataRequestAllowed(p,b)) throw Error('Forbidden'); calls++;};
  for (const p of ['/market-data/sources', '/market-data/live/status', `/market-data/versions/${id}/artifacts`])
    for (const body of [{}, null, false]) await assert.rejects(call(p, body), /Forbidden/);
  for (const p of ['https://other/market-data/sources', '//other/market-data/sources',
    '/market-data/center/../sources', '/market-data/center/%2e%2e/sources',
    '/market-data/sources#x', '/market-data/sources?method=POST', '/market-data/sources?x=?',
    '/market-data/center/platform?page_size=101', '/market-data/center/platform?page=0',
    '/market-data/center/platform?page=2&page=1', '/market-data/center/platform?page_size=1.5',
    '/market-data/center/platform?page=9007199254740992',
    '/market-data/center/platform?%70age_size=200', '/market-data/center/platform?query',
    '/market-data/center/platform?query=%ZZ', '/market-data/center/platform?query=' + 'x'.repeat(1001),
    '/market-data/versions',
    '/market-data/versions?dataset_id=not-a-hash', `/market-data/center/datasets/${id}`,
    '/market-data/center/datasets/' + 'A'.repeat(64), '/market-data/versions/not-a-uuid/artifacts',
    '/market-data/center/task-feed?ids=bad', `/market-data/center/task-feed?before=-1:${id}`,
    '/market-data/center/task-feed?snapshot=-1', '/market-data/history-catalog/refresh',
    '/market-data/live/demand', '/charts/provider/configure', '/market-data/center/tasks',
    `/market-data/versions/${id}`, `/market-data/versions/${id}/requests`,
    '/market-data/center/datasets/' + 'a'.repeat(64) + '/source'])
    await assert.rejects(call(p, undefined), /Forbidden/, p);
  assert.equal(calls, 0);
});
test('mobile preference drafts cannot alias desktop template/workspace records or stale versions', () => {
  const saved = {key:mobileWatchlistKey, kind:'setting', name:'mw.watchlists.v1', tool:'',
    version:'v1', storageKey:'stored-watchlist', operation:'save'};
  const desktop = {key:JSON.stringify(['chart','template','']), kind:'chart', name:'template', tool:'',
    version:'v2', storageKey:'stored-template', operation:'save'};
  const records = [saved, desktop];
  const save = {kind:'setting', name:'mw.watchlists.v1', tool:'', content:{value:{lists:[]}}, revision:3};
  assert.equal(mobilePreferenceRequestAllowed('save', save, records), true);
  assert.equal(mobilePreferenceRequestAllowed('read', {}, records), true);
  assert.equal(mobilePreferenceRequestAllowed('read', {key:mobileWatchlistKey}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('save', {...save, revision:-1}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('save', {...save, content:undefined}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('save', {kind:'setting',name:'mw.theme'}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('save', {...saved, tool:'line'}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('delete', saved, records), false);
  const draftWrite = {...saved, storageKey:undefined, value:{lists:[]}, base:null};
  assert.equal(mobilePreferenceRequestAllowed('draftWrite', draftWrite, records), true);
  for (const op of ['draftCheck','draftDrop','draftFailed']) {
    assert.equal(mobilePreferenceRequestAllowed(op, saved, records), true);
    assert.equal(mobilePreferenceRequestAllowed(op, {...saved, storageKey:desktop.storageKey, version:desktop.version}, records), false);
    assert.equal(mobilePreferenceRequestAllowed(op, {...saved, version:'stale'}, records), false);
    assert.equal(mobilePreferenceRequestAllowed(op, desktop, records), false);
  }
  assert.equal(mobilePreferenceRequestAllowed('draftWrite', {...draftWrite, storageKey:desktop.storageKey}, records), false);
  assert.equal(mobilePreferenceRequestAllowed('draftWrite', {...draftWrite, operation:'delete'}, records), false);
});
test('mobile symbol flags are restricted to the versioned shared setting', () => {
  assert.equal(mobileSymbolFlagsSetting({kind:'setting',name:'mw.symbol-flags.v1',tool:''}), true);
  assert.equal(mobileSymbolFlagsSetting({kind:'setting',name:'mw.symbol-flags.v1',tool:'chart'}), false);
  assert.equal(mobileSymbolFlagsSetting({kind:'setting',name:'mw.watchlists.v1',tool:''}), false);
  const draft={key:JSON.stringify(['setting','mw.symbol-flags.v1','']),kind:'setting',name:'mw.symbol-flags.v1',tool:'',version:'v1',storageKey:'flags',operation:'save'};
  assert.equal(mobilePreferenceRequestAllowed('draftCheck',draft,[draft]),true);
  assert.equal(mobilePreferenceRequestAllowed('draftCheck',{...draft,key:mobileWatchlistKey},[draft]),false);
});
test('mobile recovery lists only owned self-selected settings and preserves unrelated drafts', () => {
  const watchlist = {key:mobileWatchlistKey,kind:'setting',name:'mw.watchlists.v1',tool:'',version:'v1',storageKey:'watchlist',operation:'save'};
  const flags = {...watchlist,key:JSON.stringify(['setting','mw.symbol-flags.v1','']),name:'mw.symbol-flags.v1',storageKey:'flags'};
  const desktop = {...watchlist,key:JSON.stringify(['chart','desktop','']),kind:'chart',name:'desktop',storageKey:'desktop'};
  const drafts = [desktop,watchlist,flags,{...watchlist,kind:'chart',storageKey:'forged'}, {...flags,operation:'delete',storageKey:'deleted'}];
  const before = JSON.stringify(drafts);
  assert.deepEqual(Array.from(mobileRecoverablePreferenceDrafts(drafts), item=>item.storageKey), ['watchlist','flags']);
  assert.equal(JSON.stringify(drafts), before);
});
test('mobile exact alert reads/capabilities/ack/pause/resume', () => {
  for (const [p,b] of [['/chart-alerts'], ['/chart-alerts/events'], [`/chart-alerts/${id}`],
    ['/chart-alerts/capabilities', {}], [`/notifications/${id}/ack`, {}],
    [`/chart-alerts/${id}/lifecycle`, {action: 'pause'}], [`/chart-alerts/${id}/lifecycle`, {action: 'resume'}]])
    assert.equal(mobileAlertRequestAllowed(p,b), true, p);
});
test('forged operations fail before API call; desktop original RPC validator retained', async () => {
  let calls = 0;
  const call = async (p,b) => {if (!mobileAlertRequestAllowed(p,b)) throw Error('Forbidden'); calls++;};
  for (const [p,b] of [[`/chart-alerts/${id}/edit`, {}], ['/chart-alerts', {}],
    ['/chart-alerts/geometry', {}], [`/chart-alerts/${id}/lifecycle`, {action: 'restart'}],
    [`/chart-alerts/${id}/lifecycle`, {action: 'rebaseline'}], [`/chart-alerts/${id}/lifecycle`, {action: 'archive'}],
    [`/chart-alerts/${id}/lifecycle`, {action: 'drawing_deleted'}],
    [`/chart-alerts/${id}/lifecycle`, null], [`https://other/notifications/${id}/ack`, {}],
    [`/notifications/${id}/ack/extra`, {}], [`/chart-alerts/../notifications/${id}/ack`, {}]])
    await assert.rejects(call(p,b), /Forbidden/);
  assert.equal(calls, 0);
});
