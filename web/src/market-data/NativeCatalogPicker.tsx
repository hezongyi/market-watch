import { useContext, useState } from "react";
import { NativeUiContext } from "./NativeControls";
import { useMounted } from "./router";
import { api } from "./api";

/** Scoped source catalog lookup, returning a draft value without chart demand. */
export function NativeCatalogPicker({source,onSelect,disabled=false}:{source:string;onSelect:(row:any)=>void;disabled?:boolean}) {
  const mounted=useMounted();
  const ui=useContext(NativeUiContext),[busy,setBusy]=useState(false),[error,setError]=useState("");
  if(!ui) return null;
  async function pick() {
    if(busy || !ui) return;
    setBusy(true);setError("");
    const known=new Map<string,any>();
    try {
      const selected=await ui.pick({dialogTitle:source==="oanda" ? "选择 OANDA Practice 品种" : "选择来源品种",hiddenFilterIds:["exchange"],
        symbolTypes:[{name:"全部",value:""},{name:"外汇",value:"forex"},{name:"金属",value:"commodity"},{name:"指数",value:"index"},{name:"股票类",value:"stock"},{name:"基金",value:"fund"},{name:"期货",value:"futures"},{name:"加密",value:"crypto"},{name:"其他",value:"other"}],overrideQueryParams:{exchange:source.toUpperCase()},
        customSearchSymbols:async ({text,start=0,type="",signal}:any)=>{
          try {
            const pageSize=50,page=Math.floor(start/pageSize)+1;
            const result=await api<any>(`/market-data/history-catalog?source=${source}&query=${encodeURIComponent(text || "")}&page=${page}&page_size=${pageSize}&symbol_type=${encodeURIComponent(type)}`,undefined,signal);
            const symbols=result.items.map((row:any)=>{known.set(row.catalog_id,row);return {symbol:row.display_symbol || row.provider_symbol,ticker:row.catalog_id,
              description:`${row.label} · ${row.product_label || row.asset_class}`,exchange:source.toUpperCase(),type:({metal:"commodity",equity:"stock",etf:"fund",future:"futures"} as Record<string,string>)[row.asset_class] || row.asset_class};});
            return {symbols,symbols_remaining:Math.max(0,result.total-start-symbols.length)};
          } catch(e) {if(mounted.current && !signal?.aborted) setError(String(e));return {symbols:[],symbols_remaining:0};}
        }});
      if(selected && mounted.current) {const row=known.get(selected.ticker);if(!row) throw Error("所选来源目录已变化，请重新选择");onSelect(row);}
    } catch(e) {if(mounted.current)setError(String(e));} finally {if(mounted.current)setBusy(false);}
  }
  return <div className="dc-actions"><button type="button" disabled={disabled||busy} onClick={()=>void pick()}>{busy?"正在选择…":"选择品种"}</button>{error && <span role="alert" className="error">{error}</span>}</div>;
}
