const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM}=require(process.env.MW_JSDOM_PATH || 'jsdom');
const root=path.resolve(__dirname,'../../..');
const dom=new JSDOM('<!doctype html><html><body></body></html>',{runScripts:'outside-only',url:'https://chart.test/',pretendToBeVisual:true});
const w=dom.window;
w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
w.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
const mods={},cache={};
function req(id){if(cache[id])return cache[id].exports;assert(mods[id],'missing vendor module '+id);const m={exports:{}};cache[id]=m;mods[id](m,m.exports,req);return m.exports;}
req.d=(e,defs)=>Object.entries(defs).forEach(([k,get])=>Object.defineProperty(e,k,{enumerable:true,get}));req.r=e=>Object.defineProperty(e,'__esModule',{value:true});req.n=m=>{const fn=m&&m.__esModule?()=>m.default:()=>m;req.d(fn,{a:fn});return fn};req.o=(a,b)=>Object.prototype.hasOwnProperty.call(a,b);req.g=w;req.hmd=m=>m;req.nmd=m=>m;req.e=async()=>{};req.p='/';
w.webpackChunktradingview={push(chunk){Object.assign(mods,chunk[1]);chunk[2]?.(req)}};
const dir=path.join(root,'advanced-host/charting_library/bundles');
for(const p of fs.readdirSync(dir))if(p.endsWith('.js')){try{w.eval(fs.readFileSync(path.join(dir,p),'utf8'))}catch{}}
w.eval(fs.readFileSync(path.join(dir,'restricted-toolset.4fbfc823d8551bbb3e53.js'),'utf8'));
w.TradingView={version:()=> 'v31.1.0 6b804c486857f27920cf761aa7eb6e29d9bb6362'};
w.nativeAlertShell=async()=>({overlayBounds:()=>({width:1600,height:1000,top:38}),destroy(){},control(){}});
w.nativeAlertChunks=async()=>{};
const widget={createButton(){const node=w.document.createElement('div');w.document.body.append(node);return node;},removeButton(node){node.remove()}};
(async()=>{
 w.eval(fs.readFileSync(path.join(root,'advanced-host/native-notification-surface.js'),'utf8'));
 const surface=await w.nativeNotificationSurface(widget,err=>{throw err});
 const slot=widget.createButton();const button=await surface.createEntry(slot,'<svg width="28" height="28" viewBox="0 0 28 28"></svg>');
 assert.equal(button.tagName,'BUTTON');assert(button.classList.contains('isInteractive-GwQQdU8S'));assert(button.classList.contains('button-GwQQdU8S'));assert(slot.classList.contains('nc-system-entry-slot'));
 let clicks=0;button.addEventListener('click',()=>clicks++);button.click();assert.equal(clicks,1);
 assert.equal(button.getAttribute('aria-label'),'系统消息');
 const nativeButtonHTML=button.outerHTML;
 surface.destroy();assert.equal(slot.querySelector('button'),null);slot.remove();
 w.eval(fs.readFileSync(path.join(root,'advanced-host/study-templates.js'),'utf8'));
 const makeToolbar=()=>{
  const node=w.document.createElement('div');node.className='innerWrap-OhqNVIYA';node.innerHTML='<div class="group-MBOVGQRI"><button>symbol</button></div><div class="separatorWrap-MBOVGQRI"></div><div class="group-MBOVGQRI"><button aria-label="指标模板">templates</button></div><div class="separatorWrap-MBOVGQRI"></div><div class="group-MBOVGQRI"><button class="mw-indicator-button">indicators</button></div><div class="separatorWrap-MBOVGQRI"></div><div class="group-MBOVGQRI"><button>data</button></div>';
  w.document.body.append(node);return node;
 };
 const live=makeToolbar(),fake=makeToolbar();
 const templates=w.chartStudyTemplates(widget,null,false,err=>{throw err});
 const order=node=>[...node.children].filter(e=>e.classList.contains('group-MBOVGQRI')).sort((a,b)=>Number(a.style.order)-Number(b.style.order)).map(e=>e.textContent);
 for(const toolbar of [live,fake])assert.deepEqual(order(toolbar),['symbol','indicators','templates','data']);
 const rebuilt=makeToolbar();await new Promise(r=>setTimeout(r,20));assert.deepEqual(order(rebuilt),['symbol','indicators','templates','data']);
 templates.dispose();for(const node of [live,fake,rebuilt]){assert([...node.children].every(e=>e.style.order===''));assert.equal(node.querySelectorAll('.mw-template-separator').length,0);}
 const result={passed:true,nativeButtonHTML,checks:['actual vendor ToolbarIconButton render','native interactive class and semantic button','one click callback','native root cleanup','template visual order in live and measurement toolbar','rebuilt toolbar observed','order and separator cleanup'],limits:'JSDOM verification; no browser layout/hover painting or deployed-instance verification in restricted sandbox'};
 fs.writeFileSync('/tmp/mw-toolbar-native-local-20261020.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>w.close());
