// Exercise the actual component across control replies and subsequent worker failures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {transformSync} = require('esbuild');
const effects = [];
let reply, reject, release;
const jsx = (type, props) => ({type, props});
const modules = {
  react: {
    useEffect: effect => effects.push(effect),
    useState: value => [value, () => {}],
    useSyncExternalStore: (_, get) => get(),
  },
  'react/jsx-runtime': {jsx, jsxs:jsx, Fragment:'fragment'},
  './router': {useActionLock:()=>({acquire:()=>true,release:()=>{}})},
  './api': {api:async()=>{if(release) await release; if(reject) throw Error('control unavailable'); return reply;}},
};
const context = vm.createContext({module:{exports:{}}, require:name=>modules[name] || {}, Event, EventTarget});
vm.runInContext(transformSync(fs.readFileSync(path.join(__dirname,'../src/market-data/Tasks.tsx'),'utf8'),
  {loader:'tsx',format:'cjs',jsx:'automatic'}).code, context);
const task = (id, status, desired_state='running') => ({id,status,desired_state,controllable:true});
function render(value) {
  const props={task:value,onDone:()=>{}};
  context.module.exports.TaskActions(props);
  effects.splice(0).forEach(effect=>effect());
  const tree=context.module.exports.TaskActions(props);
  effects.splice(0).forEach(effect=>effect());
  const buttons=[];
  function walk(node) {
    if(Array.isArray(node)) return node.forEach(walk);
    if(!node || typeof node!=='object') return;
    if(node.type==='button') buttons.push(node);
    walk(node.props?.children);
  }
  walk(tree);
  return buttons;
}
const named=(buttons, label)=>buttons.find(button=>button.props.children===label);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  for(const action of ['resume','retry']) for(const failed of ['retrying','configuration_error']) {
    const id=action+'-'+failed;
    reply=task(id,'pending');
    const before=task(id,action==='resume'?'paused':'retrying',action==='resume'?'paused':'running');
    await named(render(before),action==='resume'?'恢复任务':'重试失败范围').props.onClick();
    await flush();
    // No pending/running observation: the worker failed before the next poll.
    const buttons=render(task(id,failed));
    assert.equal(named(buttons,'重试失败范围').props.disabled,false,`${action} followed by ${failed} must allow retry`);
    assert.equal(named(buttons,'取消任务').props.disabled,false,'worker failure must leave cancellation available');
    assert.equal(named(render(task(id,failed)),'重试失败范围').props.disabled,false,'reopening must remain operable');
  }
  reply=task('pause','running','paused');
  await named(render(task('pause','running')),'暂停任务').props.onClick();
  await flush();
  assert.equal(named(render(reply),'暂停任务').props.disabled,true,'pause must wait for safe worker stop');
  assert.equal(named(render(task('pause','paused','paused')),'恢复任务').props.disabled,false);
  reply={...task('derived','published','paused'),task_status:'deriving'};
  await named(render(task('derived','deriving')),'暂停任务').props.onClick();
  await flush();
  assert.equal(named(render(task('derived','deriving')),'暂停任务').props.disabled,true,
    'published M1 status in control reply must not acknowledge an unfinished derivation stop');
  assert.equal(named(render(task('derived','paused','paused')),'恢复任务').props.disabled,false);
  reject=true;
  await named(render(task('error','retrying')),'重试失败范围').props.onClick();
  await flush();
  assert.equal(named(render(task('error','retrying')),'重试失败范围').props.disabled,false,'failed control request must release busy state');
  reject=false;
  let finish;
  release=new Promise(resolve=>finish=resolve);
  reply=task('busy','pending');
  const pending=named(render(task('busy','paused','paused')),'恢复任务').props.onClick();
  assert.equal(named(render(task('busy','paused','paused')),'正在提交…').props.disabled,true,'row/detail must share in-flight control lock');
  finish();await pending;await flush();release=null;
  console.log('Task control: immediate worker failures, reopen, safe pause, failed requests and shared busy state passed');
})().catch(error=>{console.error(error);process.exitCode=1});
