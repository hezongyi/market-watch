import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const repo=path.resolve(import.meta.dirname,"../.."),out="/tmp/mw-pro-charts-20261011/ui-probe";
mkdirSync(out,{recursive:true});
for(const baseline of [true,false]) {
  await build({entryPoints:[path.join(repo,"web/tests/native-select-probe.tsx")],bundle:true,
    outfile:path.join(out,baseline?"controls-baseline.js":"controls.js"),format:"iife",platform:"browser",
    jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'},
    plugins:baseline?[{name:"baseline-control",setup(b){b.onLoad({filter:/NativeControls\.tsx$/},()=>({
      contents:execFileSync("git",["show","HEAD:web/src/market-data/NativeControls.tsx"],{cwd:repo,encoding:"utf8"}),loader:"tsx"}));}}]:[]});
  writeFileSync(path.join(out,baseline?"baseline.html":"index.html"),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="window.css"></head><body style="margin:0"><div id="chart" style="height:100vh"></div>
  <script src="/charting_library/charting_library.js"></script>
  <script src="native-ui${baseline?"-baseline":""}.js"></script><script src="controls${baseline?"-baseline":""}.js"></script><script>
  const feed={onReady:cb=>setTimeout(()=>cb({supported_resolutions:['60']}),0),resolveSymbol:(name,cb)=>setTimeout(()=>cb({name,ticker:name,description:name,type:'crypto',session:'24x7',timezone:'Etc/UTC',minmov:1,pricescale:100,has_intraday:true,supported_resolutions:['60']}),0),getBars:(symbol,res,period,cb)=>setTimeout(()=>cb([],{noData:true}),0),subscribeBars(){},unsubscribeBars(){}};
  const widget=new TradingView.widget({container:'chart',library_path:'/charting_library/',datafeed:feed,locale:'zh',symbol:'TEST',interval:'60',autosize:true,theme:'Dark',disabled_features:['use_localstorage_for_settings']});
  widget.onChartReady(async()=>{await widget.headerReady();const probe=widget.createButton({useTradingViewStyle:false}),doc=probe.ownerDocument;widget.removeButton(probe);
    const style=doc.createElement('link');style.rel='stylesheet';style.href='/window.css';doc.head.append(style);
    const ui=await chartNativeUi(widget,doc).load();const R=ui.react,container=doc.createElement('div');
    let mounted=false;ui.createRoot(R.createElement(ui.components.dialog,{isOpened:true,title:'必填控件回归',dataDialogName:'必填控件回归',draggable:true,showSeparator:true,onClose(){},render:()=>R.createElement('div',{className:'dc-window dc-window-native dc-native-fields',ref:node=>{if(node&&!mounted){mounted=true;mountSelectProbe(node,ui);}}})}),container);
  });</script></body></html>`);
}
for(const file of ['native-ui.js','native-indicator-dialog.js']) writeFileSync(path.join(out,file),readFileSync(path.join(repo,'advanced-host',file)));
writeFileSync(path.join(out,'native-ui-baseline.js'),execFileSync('git',['show','HEAD:advanced-host/native-ui.js'],{cwd:repo,encoding:'utf8'}));
writeFileSync(path.join(out,'window.css'),readFileSync(path.join(repo,'web/src/market-data/window.css')));
