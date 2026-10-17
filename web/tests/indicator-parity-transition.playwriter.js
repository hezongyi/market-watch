// Execute through Playwriter CLI -s SESSION -f FILE against the task-local probe.
// A real native restart must retain the previous, explicitly transitional curve.
const fs = require('node:fs');
const assert = require('assert').strict;
state.page ||= await context.newPage();
await state.page.goto('http://127.0.0.1:17474/?initialCount=1000', {waitUntil:'domcontentloaded'});
console.log('URL:', state.page.url());
console.log(await snapshot({page:state.page}));
console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
await state.page.waitForFunction(() => ready && widget.activeChart().dataReady());
await state.page.evaluate(async () => {parity.initialize(); await parity.add();});
await state.page.waitForFunction(() => parity.sample().size > 100);
console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
state.before = await state.page.evaluate(() => parity.sample());
await state.page.evaluate(() => {
  parity.delay = true;
  widget.activeChart().getStudyById(parity.id).setInputValues([{id:'period',value:7}]);
});
await state.page.waitForFunction(() => parity.reads.some(read => read.args.indicators.some(spec => spec.params.period === 7)));
console.log(await snapshot({page:state.page}));
console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
state.delayed = await state.page.evaluate(() => parity.sample());
state.transitionEvidence = {synthetic:true, browser:'Playwriter / pinned native runtime',
  phase:state.phase || 'baseline', before:state.before, delayed:state.delayed,
  events:await state.page.evaluate(() => parity.events),
  passed:state.delayed.size === state.before.size && state.delayed.last?.[1] === state.before.last?.[1]};
const output = '/tmp/mw-issue74-20261017/transition-' + state.transitionEvidence.phase;
await state.page.screenshot({path:output+'.png',scale:'css'});
fs.writeFileSync(output+'.json',JSON.stringify(state.transitionEvidence,null,2));
await state.page.evaluate(() => parity.release());
console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
console.log(JSON.stringify(state.transitionEvidence));
assert.ok(state.transitionEvidence.passed, 'native parameter restart cleared the valid old curve while the new result was delayed');
assert.equal(state.delayed.scope.transition?.params.period,5,'old parameter display must retain its own labelled identity');
