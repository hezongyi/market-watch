/** Native chart resources are lazy: login/settings do not depend on the library. */
export type ChartUpdate = {type:string; [key:string]:any};
export interface ChartAdapter {update(value:ChartUpdate):void|Promise<void>;start():void;dispose():void}
export type ChartRequest = (kind:string, query:any, context:{id:number;history_client?:string}, source:ChartAdapter)=>Promise<any>;
export interface ChartApplication {
  observe(value:ChartUpdate,source:ChartAdapter):void;
  market:ChartRequest;workspace:ChartRequest;session:ChartRequest;alerts:ChartRequest;notifications:ChartRequest;dataCenter:ChartRequest;
  cancel(id:number,source:ChartAdapter):void;
}
declare global {var MWChartAdapter:{mount(container:HTMLElement,application:ChartApplication):ChartAdapter};}
let assets:Promise<void>|undefined;
function script(src:string) {return new Promise<void>((resolve,reject)=>{
  const node=document.createElement("script");node.src=src;
  node.onload=()=>resolve();node.onerror=()=>{node.remove();reject(Error("图表资源加载失败，请重试"));};document.head.append(node);
});}
export async function mountChart(container:HTMLElement, application:ChartApplication) {
  if(!assets)assets=fetch('/chart-assets.json').then(response=>{if(!response.ok)throw Error("图表资源清单不可用");return response.json();})
    .then(async manifest=>{await script('/'+manifest.libraryDirectory+'/charting_library.js');await script('/'+manifest.script);})
    .catch(error=>{assets=undefined;throw error;});
  await assets;return MWChartAdapter.mount(container,application);
}
