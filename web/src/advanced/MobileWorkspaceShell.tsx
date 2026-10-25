import { useState } from "react";
import { Bell, BarChart3, Bookmark, Check, ChevronDown, ChevronUp, Ellipsis, Maximize2, RefreshCw, Settings, Trash2 } from "lucide-react";

type ChartRow = { original_index:number; original_chart_id:string|null; symbol:string; resolution:string };
type Watchlist = { id:string; title:string; symbols:string[] };
type Props = {
  tab: "chart"|"watchlist"|"alerts"|"more";
  onTab:(tab:Props["tab"])=>void;
  directory:ChartRow[];
  selectedIndex:number|null;
  exploring?:boolean;
  temporary?:boolean;
  saving?:boolean;
  chartDirty?:boolean;
  chartSaving?:boolean;
  onSaveChart?:()=>void;
  onSelectChart:(index:number)=>void;
  onOpenAlerts:()=>void;
  onFullscreen:()=>void;
  onRefresh:()=>void;
  workspaceName:string;
  activeWorkspaceId:string;
  workspaces:{id:string;name:string}[];
  onWorkspace:(id:string)=>void;
  onOpenTicker:(ticker:string)=>void;
  onSearch:(query:string)=>void;
  searchResults:{ticker:string;label:string}[];
  onSystemMessages:()=>void;
  onDataStatus:()=>void;
  onHistoryDetails:()=>void;
  onHistoryCapacity:()=>void;
  watchlists:Watchlist[];
  activeWatchlist:string;
  onWatchlistChange:(id:string)=>void;
  onWatchlistEdit:(symbols:string[])=>void;
  onAddTicker:(ticker:string)=>Promise<void>;
  flags:Record<string,string>;
  onFlag:(ticker:string,color:string|null)=>void;
  theme:"dark"|"light";
};

const flagColors:[string,string][] = [["red","红"],["blue","蓝"],["green","绿"],["yellow","黄"]];
const seriesLabel=(symbol:string)=>symbol.startsWith("MWP:")?"平台行情":symbol.startsWith("MWH:")?"固定历史":symbol.startsWith("MWC:")?"组合行情":"自建行情";

export function MobileWorkspaceShell(props:Props) {
  const [watchlistError,setWatchlistError]=useState("");
  const list=props.watchlists.find(row=>row.id===props.activeWatchlist) || props.watchlists[0];
  const edit=(fn:(symbols:string[])=>string[])=>list && props.onWatchlistEdit(fn(list.symbols));
  return <>
    <header className="mobile-shell-header">
      <div className="mobile-shell-title"><BarChart3 size={18}/><strong>图表</strong><span>{props.temporary ? "告警临时查看" : props.exploring ? "临时浏览" : props.directory.find(row=>row.original_index===props.selectedIndex)?.symbol || "工作区"}</span></div>
      <div className="mobile-shell-actions">
        <button type="button" title="系统消息" aria-label="系统消息" onClick={props.onSystemMessages}><Bell size={18}/></button>
        <button type="button" title="全屏图表" aria-label="全屏图表" onClick={props.onFullscreen}><Maximize2 size={18}/></button>
      </div>
    </header>
    {props.tab === "chart" && <section className="mobile-shell-panel mobile-chart-panel">
      {props.onSaveChart && <button type="button" className="mobile-chart-save" disabled={props.chartSaving || props.temporary || !props.chartDirty} onClick={props.onSaveChart}>{props.chartSaving?'正在保存图格…':props.chartDirty?'保存当前图格':'图格已保存'}</button>}
      <div className="mobile-panel-heading"><div><span className="mobile-kicker">工作区 · {props.workspaceName}</span><strong>{props.temporary ? "触发位置" : props.exploring ? "临时行情" : props.selectedIndex == null ? "加载中" : `原图格 ${props.selectedIndex+1}`}</strong></div><div className="mobile-heading-actions"><select aria-label="选择工作区" value={props.activeWorkspaceId} onChange={event=>props.onWorkspace(event.target.value)}>{props.workspaces.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select><button type="button" title="刷新原图格目录" aria-label="刷新原图格目录" onClick={props.onRefresh}><RefreshCw size={17}/></button></div></div>
      <div className="mobile-chart-picker">{props.directory.map(row=><button type="button" key={row.original_index} className={row.original_index===props.selectedIndex?"active":""} onClick={()=>props.onSelectChart(row.original_index)}><span>图格 {row.original_index+1}</span><strong>{row.symbol.replace(/^MW[HCP]:/,"")}</strong><small>{seriesLabel(row.symbol)} · {row.resolution}</small>{row.original_index===props.selectedIndex&&<Check size={15}/>}</button>)}</div>
    </section>}
    {props.tab === "watchlist" && <section className="mobile-shell-panel mobile-watchlist-panel" aria-busy={props.saving}><fieldset disabled={props.saving} style={{border:0,margin:0,padding:0,minWidth:0}}>
      <div className="mobile-panel-heading"><div><span className="mobile-kicker">自选</span><strong>行情列表</strong></div><select aria-label="选择自选列表" value={list?.id || ""} onChange={event=>props.onWatchlistChange(event.target.value)}>{props.watchlists.map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></div>
      <form className="mobile-watchlist-search" onSubmit={event=>{event.preventDefault();const input=event.currentTarget.elements.namedItem("ticker") as HTMLInputElement;if(input.value.trim())props.onSearch(input.value.trim());}}><input name="ticker" aria-label="搜索品种" placeholder="搜索品种或代码" maxLength={80}/><button type="submit">搜索</button></form>
      {!!props.searchResults.length && <div className="mobile-search-results">{props.searchResults.map(row=><button key={row.ticker} type="button" onClick={async()=>{setWatchlistError("");try{await props.onAddTicker(row.ticker);props.onOpenTicker(row.ticker);}catch(error){setWatchlistError(`加入自选失败：${String(error)}`);}}}><strong>{row.label}</strong><small>{row.ticker}</small></button>)}</div>}
      {watchlistError && <p className="mobile-empty" role="alert">{watchlistError}</p>}
      {!list?.symbols.length && <p className="mobile-empty">暂无品种</p>}
      <ul>{list?.symbols.map((ticker,index)=><li key={`${ticker}-${index}`}><button className="mobile-symbol" type="button" onClick={()=>{props.onOpenTicker(ticker);props.onTab("chart");}}><Bookmark size={15} fill={props.flags[ticker] ? "currentColor":"none"}/><span>{ticker.replace(/^MW[HCP]:/,"")}</span></button><div className="mobile-row-actions"><button type="button" title="上移" aria-label={`${ticker} 上移`} disabled={index===0} onClick={()=>edit(items=>{const next=[...items];[next[index-1],next[index]]=[next[index],next[index-1]];return next;})}><ChevronUp size={16}/></button><button type="button" title="下移" aria-label={`${ticker} 下移`} disabled={index===list.symbols.length-1} onClick={()=>edit(items=>{const next=[...items];[next[index+1],next[index]]=[next[index],next[index+1]];return next;})}><ChevronDown size={16}/></button><button type="button" title="移除" aria-label={`${ticker} 移除`} onClick={()=>edit(items=>items.filter((_,itemIndex)=>itemIndex!==index))}><Trash2 size={16}/></button>{flagColors.map(([color,label])=><button key={color} type="button" className="mobile-flag" title={`旗标${label}`} aria-label={`${ticker} 旗标${label}`} data-color={color} onClick={()=>props.onFlag(ticker,props.flags[ticker]===color?null:color)} />)}</div></li>)}</ul>
    </fieldset></section>}
    {props.tab === "more" && <section className="mobile-shell-panel mobile-more-panel"><div className="mobile-panel-heading"><div><span className="mobile-kicker">更多</span><strong>工作区工具</strong></div><Ellipsis size={18}/></div><button className="mobile-menu-row" type="button" onClick={props.onRefresh}><RefreshCw size={17}/><span>刷新工作区</span></button><button className="mobile-menu-row" type="button" onClick={props.onSystemMessages}><Bell size={17}/><span>系统消息</span></button><a className="mobile-menu-row" href="/settings"><Settings size={17}/><span>设置与账户</span></a><button className="mobile-menu-row" type="button" onClick={props.onHistoryDetails}><BarChart3 size={17}/><span>历史加载详情</span></button><button className="mobile-menu-row" type="button" onClick={props.onHistoryCapacity}><Settings size={17}/><span>历史数据容量</span></button><button className="mobile-menu-row" type="button" onClick={props.onDataStatus}><BarChart3 size={17}/><span>数据状态</span></button></section>}
    <nav className="mobile-bottom-nav" aria-label="移动端导航"><button className={props.tab==='chart'?"active":""} type="button" onClick={()=>props.onTab("chart")}><BarChart3 size={19}/><span>图表</span></button><button className={props.tab==='watchlist'?"active":""} type="button" onClick={()=>props.onTab("watchlist")}><Bookmark size={19}/><span>自选</span></button><button className={props.tab==='alerts'?"active":""} type="button" onClick={()=>props.onTab("alerts")}><Bell size={19}/><span>告警</span></button><button className={props.tab==='more'?"active":""} type="button" onClick={()=>props.onTab("more")}><Ellipsis size={19}/><span>更多</span></button></nav>
  </>;
}
