const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const source = fs.readFileSync('../advanced-host/chart-runtime.js', 'utf8');
const notify = source.slice(source.indexOf('function marketRequestNotice('), source.indexOf('function indicatorFault('));
const start = source.indexOf("  if(m.type==='market-event') {");
const branch = source.slice(start, source.indexOf('    const sub=[...subscriptions.values()]', start)) + '  }';
const notices = [], quote = {listeners: [{listener: 'live', generation: 1, sequence: 0, ticker: 'MWP:EURUSD'}], cb() {}};
const sandbox = {crypto, emitNotice: (fault, recovered = false) => notices.push({fault, recovered}),
  quoteSubscriptions: new Map([['one', quote]]), quoteSnapshotRows: new Map(), rememberQuoteRows() {}, presentQuote: row => row};
vm.createContext(sandbox);
vm.runInContext(notify + '\nthis.deliver=function(m){' + branch + '};', sandbox);
const fail = () => sandbox.marketRequestNotice(quote, 'MWP:EURUSD', 'quotes', Error('initial HTTP failed'));
const deliver = (sequence, generation, fetch_status) => sandbox.deliver({type: 'market-event',
  event: {type: 'quotes', listener: 'live', sequence, generation, quotes: [{s: 'ok', v: {lp: 1, fetch_status}}]}});
fail(); fail(); assert.equal(notices.length, 1);
deliver(1, 1, 'fetch_failed'); assert.equal(quote.noticeOutages.size, 1, 'cached price is not a recovery');
deliver(2, 2, 'ok'); assert.equal(quote.noticeOutages.size, 1, 'different generation cannot recover');
deliver(2, 1, 'ok'); assert.equal(quote.noticeOutages.size, 0);
assert.equal(notices.at(-1).recovered, true);
fail(); sandbox.endMarketRequestObservation(quote);
assert.equal(notices.at(-1).fault.observation_ended, true, 'ending an owner is explicitly distinct from recovery');
assert.equal(quote.noticeOutages.size, 0);
// Execute the real load-reset prefix and assert message ordering/context.
const resetStart=source.indexOf('    widget.subscribe("chart_load_requested", () => {');
const resetPrefix=source.slice(source.indexOf('\n',resetStart)+1,source.indexOf('      quoteSnapshotRows.clear();',resetStart));
const resetMessages=[];
Object.assign(sandbox,{workspaceEpoch:7,alertUIWorkspace:'test',alertUISession:'session',
  send:message=>resetMessages.push(message),invalidateAlertUI(){},barRangeMapping:{suspend(){}},
  edgeGuard:null,rangeGuard:null,indicatorCoordinator:null,indicatorBindings:new Map(),
  subscriptions:new Map(),pendingSync:{},syncCoordinator:{resetWorkspace(){},acquirePause(){}},
  feed:{unsubscribeQuotes:id=>{sandbox.endMarketRequestObservation(quote);sandbox.quoteSubscriptions.delete(id)},unsubscribeBars(){}}});
sandbox.emitNotice=(fault,recovered)=>resetMessages.push({type:'notice-source',epoch:sandbox.workspaceEpoch,fault,recovered});
fail();resetMessages.length=0;
vm.runInContext(resetPrefix,sandbox);
const ended=resetMessages.findIndex(message=>message.fault?.observation_ended);
const reset=resetMessages.findIndex(message=>message.type==='native-load-reset');
assert.ok(ended>=0 && ended<reset,'ending must arrive before parent switches its epoch fence');
assert.equal(resetMessages[ended].epoch,7,'ending retains the failure context epoch');
assert.equal(resetMessages[reset].epoch,8);
console.log('PASS initial request/SSE recovery, cached failures, generation fences and observation ending');
