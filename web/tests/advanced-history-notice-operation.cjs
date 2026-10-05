const fs=require("node:fs"),vm=require("node:vm"),assert=require("node:assert/strict"),ts=require("typescript");
let now=16000, ticking=false;
const jsx=(type,props)=>({type,props});
const ctx={exports:{},require:name=>name==="react"?{
  useState:()=>[now,()=>{}],useEffect:fn=>fn(),
}:{jsx,jsxs:jsx},Date:class extends Date {static now(){return now;}},setInterval:()=>{ticking=true;return 1;},clearInterval:()=>{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync("src/advanced/HistoryLoadingNotice.tsx","utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}
}).outputText,ctx);
const text=node=>Array.isArray(node)?node.map(text).join(""):node==null||typeof node==="boolean"?"":
  typeof node==="object"?text(node.props?.children):String(node);
const notice={instrument:"EURUSD",timeframe:"M5",phase:"filling",message:"边界补齐",
  id:1,started:1000,totalBars:60000,loadedBars:20000,estimatedPages:15,pages:5,batch:2,completedBatch:1};
const load={instrument:"EURUSD",timeframe:"M5",phase:"filling",count:20000,started:11000,
  estimatedPages:5,pages:2,from:1000,to:2000,epoch:1,boundaryId:1,batch:2};
const props={capacities:{source:notice},loads:{current:load},onCancel(){},onDismiss(){},onSettings(){}};
let rendered=text(ctx.exports.HistoryLoadingNotice(props));
const liveRegions = node => Array.isArray(node) ? node.flatMap(liveRegions) :
  node && typeof node === "object" ? [
    ...(node.props?.["aria-live"] === "polite" ? [text(node)] : []),
    ...liveRegions(node.props?.children),
  ] : [];
assert.ok(liveRegions(ctx.exports.HistoryLoadingNotice(props)).every(value => !/\d+\s*秒/.test(value)),
  "elapsed ticker must not announce seconds repeatedly through a live region");
assert.match(rendered,/已等待\s*15\s*秒/,
  "elapsed must span the full boundary operation, not restart with its second 20k batch");
assert.match(rendered,/预计补齐 60,000 根/);
assert.match(rendered,/累计新增缓存 7 页/);
assert.match(rendered,/预计总共约 15 页/);
rendered=text(ctx.exports.HistoryLoadingNotice({...props,
  capacities:{source:{...notice,pages:7,completedBatch:2}}}));
assert.match(rendered,/累计新增缓存 7 页/,
  "completed batch moves into operation pages without counting retained getBars state twice");
rendered=text(ctx.exports.HistoryLoadingNotice({...props,
  capacities:{source:{...notice,phase:"limited",pages:7,finished:14000}}}));
assert.match(rendered,/本次补齐耗时\s*13\s*秒/);
ticking=false;
ctx.exports.HistoryLoadingNotice({...props,loads:{}});
assert.equal(ticking,true,"boundary-only loading must keep its elapsed clock running between getBars batches");
console.log("History operation notice: cumulative boundary bars/pages and uninterrupted elapsed clock passed");
