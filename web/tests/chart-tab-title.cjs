// Exercise the real parent message handler and document.title writer together.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync('src/advanced/ChartApplicationPage.tsx','utf8');
const writer=source.slice(source.indexOf('  const updateTitle ='),source.indexOf('  const remember ='));
const start=source.indexOf('      if (m.type === "active-quote") {');
const end=source.indexOf('      if (m.type === "alerts-panel-state"',start);
assert.ok(start>0&&end>start);
const ctx={document:{title:''},current:{current:{id:'workspace',name:' 我的图表 '}},
 titleText:{current:''},titleQuote:{current:''},titleHistorical:{current:false},titleIdentity:{current:''},
 titleTimer:{current:null},titleLast:{current:0},appLocation:{pathname:'/advanced-charts/workspace'},
 pageName:()=> '图表',performance:{now:()=>1000},setTimeout:fn=>{fn();return null;},clearTimeout:()=>{}};
vm.createContext(ctx);
vm.runInContext(ts.transpileModule(writer+'\nfunction receive(m){'+source.slice(start,end)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
let generation=0;
function receive(quote){ctx.receive({type:'active-quote',workspace_id:'workspace',ticker:'MWC:'+'a'.repeat(64),label:'EURUSD',generation:++generation,...quote});return ctx.document.title;}
assert.equal(receive({price:1.12449,formatted:'1.12449',change:0.12287}),'EURUSD 1.12449 ▲ +0.12% 我的图表');
assert.equal(receive({price:1.10000,formatted:'1.10000',change:-0.127}),'EURUSD 1.10000 ▼ −0.13% 我的图表');
assert.equal(receive({price:1.1,formatted:'1.10000',change:0}),'EURUSD 1.10000 0.00% 我的图表');
assert.equal(receive({historical:true,price:1.12224,formatted:'1.12224',change:3,delayed:true}),'EURUSD·历史 [我的图表]');
ctx.current.current.name='研究';
vm.runInContext('updateTitle(true)',ctx);
assert.equal(ctx.document.title,'EURUSD·历史 [研究]');
assert.equal(receive({historical:true}),'EURUSD·历史 [研究]');
assert.equal(receive({price:1.1,formatted:'1.10000',change:1}),'EURUSD 1.10000 ▲ +1.00% 研究');
const previous=ctx.document.title;
receive({workspace_id:'old',historical:true});
assert.equal(ctx.document.title,previous,'old workspace must not replace the current tab');
console.log('tab title: positive/negative/zero, history without price, layout rename and workspace fence passed');
