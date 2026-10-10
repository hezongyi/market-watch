/* The only adapter to the installed, version-pinned native UI implementation.
 * No chart-properties renderer, model or undo checkpoint is used here.
 */
function chartNativeUi(widget, doc, searchSymbols) {
  const expected = "6b804c486857f27920cf761aa7eb6e29d9bb6362";
  const win = doc.defaultView;
  let loading, enhanceSymbolSearch;
  // Adapt the dialog-opening boundary before the lazy search module executes.
  // Keep the licensed factory and all native selection/close callbacks intact.
  function searchFactory(original) {
    if (original.mwSearchAdapter) return original;
    function adapted(module, exports, req) {
      original(module, exports, req);
      const native = module.exports;
      module.exports = {...native, showSymbolSearchItemsDialog(options) {
        if(enhanceSymbolSearch) return native.showSymbolSearchItemsDialog(enhanceSymbolSearch(options));
        let dialog,closed=false;
        void load().then(()=>{if(!closed) dialog=native.showSymbolSearchItemsDialog(enhanceSymbolSearch?.(options) || options);})
          .catch(()=>{if(!closed) dialog=native.showSymbolSearchItemsDialog(options);});
        return {close(){closed=true;dialog?.close();}};
      }};
    }
    adapted.mwSearchAdapter = true;
    return adapted;
  }
  function prepareSearch() {
    if(!searchSymbols || !String(TradingView.version()).includes(expected)) return;
    let req;
    win.webpackChunktradingview.push([[`mw-symbol-search-${crypto.randomUUID()}`],{},value=>{req=value;}]);
    if (!req?.m || win.mwSymbolSearchFactoryInstalled) return;
    win.mwSymbolSearchFactoryInstalled = true;
    if(req.m[457185]) req.m[457185] = searchFactory(req.m[457185]);
    const chunkPush = win.webpackChunktradingview.push;
    win.webpackChunktradingview.push = function(chunk) {
      if(chunk[1]?.[457185]) chunk[1][457185] = searchFactory(chunk[1][457185]);
      return chunkPush.call(this,chunk);
    };
  }
  prepareSearch();
  async function load() {
    if (!String(TradingView.version()).includes(expected)) throw Error("原生界面版本尚未适配");
    if (loading) return loading;
    loading = (async () => {
      if (!String(TradingView.version()).includes(expected)) throw Error("原生界面版本尚未适配");
      let req;
      win.webpackChunktradingview.push([[`mw-native-ui-${crypto.randomUUID()}`], {}, value => { req = value; }]);
      if (!req?.e || !req.m[114063]) throw Error("原生界面加载器不可用");
      // Load the same dependency chunks as this build's settings UI, without
      // opening settings, changing a property, or creating an undo transaction.
      const chunks = [50591,83159,82593,43946,34663,74219,1355,52485,50160,85997,17039,10162,16651,70221,18566,55578,50779,85715,15043,67351,69437,96868,84551,34853,10627,4500,43296,16687,97839,39983,8117,15211,88090,75856,23819,32327,38729,47649,29520,1644,9876,60451,55921,5840,87829,16468,19937,39047,57818,13885,31049,72414,39919,93041,30714,79086,8318,99224,84277,26703,70814,20774,29365,50254,91947,36145,83520,32171,50225,3854,36702,34540,39218,56595,50625];
      await Promise.all([req(114063).loadNewSymbolSearch(), ...chunks.map(id => req.e(id))]);
      const R = req(779474), createRoot = req(590263).createReactRoot;
      const Search = req(154676).SymbolSearchItemsDialog;
      const SearchContext = req(886925).SymbolSearchItemsDialogContext;
      const BodyContext = req(48591).SymbolSearchDialogBodyContext;
      const SearchRow = req(620748).SymbolSearchDialogContentItem;
      if(!Search || !SearchContext || !BodyContext || !SearchRow) throw Error("原生平台行情搜索不可用");
      const PlatformContext = R.createContext(null);
      const listClasses = req(198629), rowClasses = req(910890), headerClasses = req(86731);
      const Select = req(221339).Select, createPortal = req(129365).createPortal, searchClasses=req(176871);
      const platformStyle = doc.createElement("style");
      platformStyle.textContent = `
        .mw-platform-search,.mw-platform-inline{height:100%;min-height:0;display:flex;flex-direction:column;width:100%}
        .mw-platform-inline>div{min-width:0;flex-shrink:0}
        .mw-platform-inline>.${listClasses.wrap}{width:100%;flex:1;min-height:0}
        .mw-platform-inline .${listClasses.scrollContainer}{scroll-padding-top:40px}
        .mw-platform-inline .${rowClasses.actionsCell}{width:auto;min-width:124px;padding-inline:4px}
        .mw-platform-inline .${rowClasses.symbolTitle}{max-width:200px}
        .mw-platform-inline [data-name="round-tabs-buttons"]{margin-top:8px}
        .mw-platform-inline .mw-platform-action{font:inherit;font-size:13px;color:var(--ink);border:0;border-radius:4px;background:transparent;cursor:pointer;white-space:nowrap;padding:6px;min-height:32px}
        .mw-platform-inline .mw-platform-action:hover{background:var(--card)}
        .mw-platform-inline .mw-platform-action:disabled{opacity:.5;cursor:default}
        .mw-platform-inline .mw-platform-action:focus-visible{outline:2px solid var(--green);outline-offset:-2px}
        .mw-platform-inline input[role="searchbox"]:focus,.mw-platform-inline input[role="searchbox"]:focus-visible{outline:none!important;box-shadow:none!important;border-color:var(--control-line,#d9d9d9)!important}
        [data-dialog-name^="选择 "] input[role="searchbox"]:focus,[data-dialog-name^="选择 "] input[role="searchbox"]:focus-visible{outline:none!important;box-shadow:none!important}
        .mw-platform-source{margin-left:auto;min-width:120px;max-width:180px}
        .mw-platform-status{font-size:12px;color:var(--muted);padding:8px 20px;flex-shrink:0}
        .mw-platform-status[role=alert]{color:var(--danger)}
        @media(max-width:800px){.mw-platform-inline .${rowClasses.actionsCell}{min-width:0;width:auto}}
      `;
      doc.head.append(platformStyle);
      function PlatformWrapper(props) {
        return R.createElement("div", {className:"mw-platform-search"}, props.children);
      }
      function PlatformInline(props) {
        const ctx = R.useContext(SearchContext), platform = R.useContext(PlatformContext);
        const container=R.useRef(null);
        const [sourceHeader,setSourceHeader]=R.useState(null);
        const [source, setSource] = R.useState(platform.latest.current.source || "");
        const selected = ctx.searchSources.find(item => item.value().toLowerCase() === source) || ctx.searchSources.find(item => item.value() === "");
        // The native controller normally persists its source to the main
        // symbol-search settings. Give this embedded search its own source.
        const scoped = {...ctx, selectedSearchSource:selected, setSelectedSearchSource:item=>setSource(item.value().toLowerCase()),
          symbolSearchContent:{...ctx.symbolSearchContent,currentSelectedSearchSource:selected,canChangeExchange:false},
          handleListWidth:ctx.handleListWidth};
        function keyboard(event) {
          if (event.target !== ctx.searchRef.current || ctx.mode !== "symbolSearch") return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();event.stopPropagation();
            const next = Math.max(0, Math.min(ctx.feedItems.length-1,ctx.selectedIndex+(event.key === "ArrowDown"?1:-1)));
            ctx.setSelectedIndex(next);return;
          }
          if (event.key === "Enter" && !event.isComposing && ctx.selectedIndex >= 0) {
            event.preventDefault();event.stopPropagation();void platform.open(ctx.feedItems[ctx.selectedIndex]?.item?.ticker).catch(()=>{});
          }
        }
        R.useLayoutEffect(()=>{
          const input=container.current?.querySelector('input[role="searchbox"]');
          if(input) input.setAttribute("aria-label","搜索品种");
          ctx.listWrapRef.current?.classList.add("dc-platform-scroll");
          // The native header keeps its code/description columns. Render the
          // same Select used by management forms into its right-hand cell.
          const header=container.current?.querySelector(`.${headerClasses.wrap} > .${headerClasses.item}:last-child`);
          setSourceHeader(header || null);
        });
        const items=ctx.searchSources.filter(item=>!platform.latest.current.allowedSources || !item.value() || platform.latest.current.allowedSources.includes(item.value().toLowerCase())).map(item=>({value:item.value().toLowerCase(),content:item.value() ? item.name() : "全部来源"}));
        return R.createElement(SearchContext.Provider,{value:scoped},R.createElement("div",{
          ref:container,className:"mw-platform-inline",onKeyDown:keyboard,"aria-label":"平台行情搜索",
        },props.render(),sourceHeader && createPortal(R.createElement("div",{className:"dc-select-control mw-platform-source"},
          R.createElement("div",{className:"dc-native-slot","data-native-component":"select"},
            R.createElement(Select,{value:source,items,onChange:value=>{setSource(value);ctx.setSelectedIndex(-1);},
              "aria-label":"来源",size:"small",className:"dc-native-select"}))),sourceHeader)));
      }
      function PlatformRow(props) {
        const platform = R.useContext(PlatformContext), [opening,setOpening]=R.useState(false);
        const ctx = R.useContext(SearchContext);
        const actionable = ["good", "loadingWithPaginated"].includes(ctx.symbolSearchState);
        const ticker=props.item.ticker;
        const selecting=platform.latest.current.mode === "select",selected=platform.latest.current.selectedTicker === ticker;
        async function open(event) {
          event?.stopPropagation();
          if(!actionable || platform.lock.current || platform.latest.current.busy || !props.item.available) return;
          setOpening(true);
          try {await platform.open(ticker);}
          catch(error) { /* The business root displays the apply error. */ }
          finally {if(platform.alive.current)setOpening(false);}
        }
        const actions=R.createElement(R.Fragment,null,
          props.item.available && R.createElement("button",{id:props.item.rowId+"-open",type:"button",className:"mw-platform-action",onClick:open,disabled:!actionable || platform.latest.current.busy,tabIndex:actionable?0:-1,"aria-pressed":selecting?selected:undefined,"aria-busy":opening||undefined},selecting?(selected?"已选择":"选择"):opening?"正在打开…":"打开图表"),
          !selecting && R.createElement("button",{id:props.item.rowId+"-details",type:"button",className:"mw-platform-action",disabled:!actionable,tabIndex:actionable?0:-1,onClick:event=>{event.stopPropagation();platform.latest.current.onDetails(ticker);}},"详情"));
        return R.createElement(SearchRow,{...props,
          title:props.item.symbol,dangerousTitleHTML:undefined,description:props.item.description,dangerousDescriptionHTML:undefined,
          itemRef:node=>{if(typeof props.itemRef === "function")props.itemRef(node);else if(props.itemRef)props.itemRef.current=node;if(node){node.id=props.item.rowId;node.tabIndex=-1;node.dataset.selected=String(selected);}},
          marketType:props.item.category,exchangeName:props.item.sourceName,onClick:open,actions});
      }
      function PlatformStatus() {
        const platform=R.useContext(PlatformContext),ctx=R.useContext(SearchContext),body=R.useContext(BodyContext);
        const {error,request,remaining,loading}=platform.state;
        return R.createElement("div",{className:"mw-platform-status",role:error?"alert":"status"},
          error ? R.createElement(R.Fragment,null,"读取失败，已有结果保留。",R.createElement("button",{type:"button",className:"mw-platform-action",disabled:loading,onClick:()=>body.updateRecommends(request.text,request.type,ctx.selectedSearchSource,request.start)},loading?"正在重试…":"重试")) : !loading && remaining === 0 && ctx.symbolSearchState === "good" ? "已全部加载" : "");
      }
      function PlatformSearch(props) {
        const latest=R.useRef(props);latest.current=props;
        const alive=R.useRef(true),lock=R.useRef(false);
        const open=R.useCallback(async ticker=>{
          if(lock.current || latest.current.busy) return;
          lock.current=true;
          try {await latest.current.onOpen(ticker);}
          finally {lock.current=false;}
        },[]);
        const [state,setState]=R.useState({error:"",loading:false,remaining:null,request:null});
        R.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
        const search=R.useCallback(async request=>{
          if(alive.current)setState({error:"",loading:true,remaining:null,request});
          try {
            const result=await latest.current.getPage(request);
            if(!request.signal.aborted && alive.current)setState({error:"",loading:false,remaining:result.symbols_remaining,request});
            return result;
          } catch(error) {
            if(request.signal.aborted) throw new win.DOMException("查询已取消","AbortError");
            if(alive.current)setState({error:String(error),loading:false,remaining:null,request});
            return {symbols:[],symbols_remaining:0};
          }
        },[]);
        // The native renderer owns search, round category tabs, the table header,
        // result rows and the scrolling sentinel. It does not own chart apply.
        return R.createElement(PlatformContext.Provider,{value:{latest,alive,lock,state,open}},R.createElement(Search,{
          initialMode:"symbolSearch",dialogTitle:props.title||"平台行情",defaultValue:props.query||"",placeholder:"品种代码或名称",
          wrapper:PlatformWrapper,dialog:PlatformInline,contentItem:PlatformRow,footer:R.createElement(PlatformStatus),
          autofocus:false,selectSearchOnInit:false,shouldReturnFocus:false,disableRecents:true,showRecents:false,showSpreadActions:false,
          symbolTypes:props.symbolTypes,selectedSymbolSettingsKey:(props.settingsScope||"mw.data-center.platform")+".category",filterValuesSettingsKey:(props.settingsScope||"mw.data-center.platform")+".filters",
          customSearchSymbols:search,onClose:()=>{},onSearchComplete:()=>{},
        }));
      }
      // Symbol search and watchlist add keep their native dialogs, category
      // tabs, rows and actions. Both use the same table-header controls.
      function SymbolFiltersBody({render,controls}) {
        const node=R.useRef(null),[header,setHeader]=R.useState(null);
        R.useLayoutEffect(()=>{
          setHeader(node.current?.querySelector(`.${headerClasses.wrap} > .${headerClasses.item}:last-child`) || null);
        });
        R.useEffect(()=>{
          const root=node.current?.closest('[data-name="symbol-search-items-dialog"],[data-name="watchlist-symbol-search-dialog"]');
          function keyboard(event) {
            if(event.defaultPrevented || event.key !== "Tab") return;
            const targets=[...(root?.querySelectorAll('button,input,[tabindex="0"]') || [])]
              .filter(node=>!node.disabled && node.tabIndex>=0 && node.getClientRects().length);
            const index=targets.indexOf(doc.activeElement),next=index+(event.shiftKey?-1:1);
            if(targets.length && (index<0 || next<0 || next>=targets.length)) {
              event.preventDefault();event.stopPropagation();targets[event.shiftKey?targets.length-1:0].focus();
            }
          }
          root?.addEventListener("keydown",keyboard,true);
          return()=>root?.removeEventListener("keydown",keyboard,true);
        },[]);
        return R.createElement("div",{ref:node,className:"mw-symbol-search-body"},render(),header && createPortal(controls,header));
      }
      function SymbolFiltersDialog({scope,nativeDialog:NativeDialog,...props}) {
        const ctx=R.useContext(SearchContext);
        const [kind,setKind]=R.useState("all"),[source,setSource]=R.useState("");
        scope.kind=kind;
        const selected=R.useMemo(()=>{
          const item=ctx.searchSources.find(item=>item.value().toLowerCase()===source) || ctx.searchSources.find(item=>item.value()==="");
          // A type change also invalidates the native feed and its old request,
          // even when the source value is unchanged.
          return item ? Object.create(item) : item;
        },[source,kind]);
        const scoped={...ctx,selectedSearchSource:selected,setSelectedSearchSource:item=>setSource(item.value().toLowerCase()),
          symbolSearchContent:{...ctx.symbolSearchContent,currentSelectedSearchSource:selected,canChangeExchange:false}};
        const sources=ctx.searchSources.map(item=>({value:item.value().toLowerCase(),content:item.value()?item.name():"全部来源"}));
        const kinds=[{value:"all",content:"全部行情"},{value:"provider",content:"平台行情"},
          {value:"history",content:"自建行情"},{value:"composite",content:"组合行情"}];
        const control=(label,value,items,onChange)=>R.createElement("div",{className:"dc-select-control mw-symbol-search-select","data-native-component":"select"},
          R.createElement(Select,{"aria-label":label,value,items,onChange:next=>{
            if(next===value) return;
            ctx.setSelectedIndex(-1);
            ctx.setSymbolSearchContent(previous=>({...previous,renderSymbolSearchList:[],symbolsRemaining:0,symbolStartIndex:0}));
            ctx.setSymbolSearchState("loading");onChange(next);
          },size:"small",className:"dc-native-select"}));
        const controls=R.createElement("div",{className:"mw-symbol-search-filters"},
          control("行情类型",kind,kinds,setKind),control("来源",source,sources,setSource));
        if(NativeDialog) {
          // Keep the connected watchlist dialog and its Enter/Shift+Enter,
          // add/remove callbacks, footer and watchlist context intact.
          return R.createElement(SearchContext.Provider,{value:scoped},R.createElement(NativeDialog,{
            ...props,render:()=>R.createElement(SymbolFiltersBody,{render:props.render,controls})}));
        }
        const dialogClasses=req(973134);
        function keyboard(event) {
          if(event.defaultPrevented) return;
          if(event.target !== ctx.searchRef.current) return;
          if(event.key === "Escape") {event.preventDefault();ctx.onClose();}
          else if(event.key === "Enter" && !event.isComposing) {event.preventDefault();ctx.onSubmit(true);}
          else if(["ArrowDown","ArrowUp"].includes(event.key)) {
            event.preventDefault();
            ctx.setSelectedIndex(Math.max(0,Math.min(ctx.feedItems.length-1,ctx.selectedIndex+(event.key==="ArrowDown"?1:-1))));
          }
        }
        return R.createElement(SearchContext.Provider,{value:scoped},R.createElement(req(450259).AdaptivePopupDialog,{
          ...props,className:[dialogClasses.dialog,!ctx.isMobile && (ctx.isTablet?dialogClasses.tabletDialog:dialogClasses.desktopDialog)].filter(Boolean).join(" "),
          backdrop:true,draggable:false,onKeyDown:keyboard,closeAriaLabel:"关闭商品代码搜索",
          render:()=>R.createElement(SymbolFiltersBody,{render:props.render,controls})}));
      }
      if(searchSymbols) {
        const searchStyle=doc.createElement("style");
        searchStyle.textContent=`.mw-symbol-search-body{display:flex;flex-direction:column;min-height:0;flex:1}
          .mw-symbol-search-body>.${listClasses.wrap}{min-height:0;flex:1}
          .mw-symbol-search-body .${headerClasses.wrap}{min-height:48px}
          .mw-symbol-search-body>.${listClasses.wrap}.${listClasses.noFeed}{max-height:50px;flex:0 0 50px}
          .mw-symbol-search-body .${listClasses.noFeed} [data-symbol-name]{display:none}
          .mw-symbol-search-body .${searchClasses.spinnerWrap}{pointer-events:none}
          .mw-symbol-search-filters{display:flex;gap:8px;margin-left:auto;flex-shrink:0}
          .mw-symbol-search-select{width:128px;min-width:0}
          .mw-symbol-search-select>[data-role=listbox]{width:100%;box-sizing:border-box}
          @media(max-width:600px){.mw-symbol-search-body .${headerClasses.wrap}{flex-wrap:wrap;row-gap:8px}
            .mw-symbol-search-body>.${listClasses.wrap}.${listClasses.noFeed}{max-height:88px;flex-basis:88px}
            .mw-symbol-search-body .${headerClasses.wrap}>.${headerClasses.item}:last-child{flex:1;min-width:272px}}
          @media(max-width:360px){.mw-symbol-search-select{width:116px}
            .mw-symbol-search-body .${headerClasses.wrap}>.${headerClasses.item}:last-child{min-width:248px}}`;
        doc.head.append(searchStyle);
        enhanceSymbolSearch=options=>{
          // Account-scoped catalog pickers and compare dialogs retain their
          // own filters. Only the pinned native watchlist picker shares ours.
          const watchlist=options.searchInitiationPoint === "watchlist";
          if(options.customSearchSymbols || (options.dialog && !watchlist)) return options;
          const scope={kind:"all"};
          const Dialog=props=>R.createElement(SymbolFiltersDialog,{...props,scope,nativeDialog:watchlist?options.dialog:undefined});
          return {...options,dialog:Dialog,disableRecents:true,showRecents:false,
            customSearchSymbols:async request=>{
              try {
                const page=await searchSymbols({kind:scope.kind,userInput:request.text,exchange:request.exchange,
                  symbolType:request.type,start:request.start,signal:request.signal});
                if(request.signal?.aborted) throw new win.DOMException("查询已取消","AbortError");
                return {symbols:page.items,symbols_remaining:page.remaining};
              } catch(error) {
                if(request.signal?.aborted) throw new win.DOMException("查询已取消","AbortError");
                throw error;
              }
            }};
        };
      }
      const components = {
        dialog: req(450259).AdaptivePopupDialog,
        sidebar: req(649867).DialogSidebarWrapper,
        sidebarItem: req(649867).DialogSidebarItem,
        search: req(357723).DialogSearch,
        input: req(909536).InputControl,
        checkbox: req(343577).Checkbox,
        select: req(221339).Select,
        platformSearch: PlatformSearch,
      };
      for (const [name, component] of Object.entries(components))
        if (!component) throw Error(`原生控件不可用：${name}`);
      function mount(kind, node, props) {
        const component = components[kind];
        if (!component) throw Error("未知原生控件");
        node.dataset.nativeComponent = kind;
        if(kind === "platformSearch") req(371996).setValue((props.settingsScope||"mw.data-center.platform")+".category",props.asset || "");
        const element = value => kind === "sidebar" ? R.createElement(component, {className:value.className},
          R.createElement("div", {ref:value.contentRef})) : R.createElement(component, value);
        let root = createRoot(element(props), node);
        return { update(next) { root?.render(element(next)); },
          dispose() { root?.unmount(); root = null; delete node.dataset.nativeComponent; } };
      }
      const popupCancels=new Set();
      let nativeIndicators;
      const ui = { mount, components, react: R, createRoot,
        async openIndicators(options) {
          if (!String(TradingView.version()).includes(expected)) throw Error("原生指标版本尚未适配");
          if (!nativeIndicators) {
            await req.e(46439);
            nativeIndicators = chartNativeIndicators(widget,doc,req,ui);
          }
          nativeIndicators.open(options);
          return nativeIndicators;
        },
        cancelPopups() {if(!popupCancels.size)return;widget.closePopupsAndDialogs();for(const cancel of [...popupCancels]) cancel();popupCancels.clear();},
        sidebarClasses: req(40806),
        pick(options) {
          return new Promise((resolve, reject) => {
            let completed = false, picker;
            const cancel=()=>{popupCancels.delete(cancel);completed=true;resolve(null);};
            popupCancels.add(cancel);
            try {
              picker = req(21021).showSymbolSearchItemsDialog({
                dialogTitle: "选择品种", showSpreadActions: false,
                disableRecents: true, shouldReturnFocus: true,
                selectedSymbolSettingsKey: "mw.data-center.picker",
                filterValuesSettingsKey: "mw.data-center.picker.filters",
                ...options,
                onSearchComplete(rows) { popupCancels.delete(cancel);completed = true; resolve(rows[0]?.result || null); },
                onClose() { if (!completed) cancel(); },
              });
              if (!picker) {popupCancels.delete(cancel);reject(Error("请先关闭已打开的商品搜索"));}
            } catch (error) {popupCancels.delete(cancel);reject(error);}
          });
        },
        notice: params => widget.showNoticeDialog(params),
        confirm: params => new Promise(resolve => {
          const cancel=()=>{popupCancels.delete(cancel);resolve(false);};popupCancels.add(cancel);
          try {widget.showConfirmDialog({...params,callback:value=>{popupCancels.delete(cancel);resolve(value);}});}
          catch(error) {cancel();}
        }),
      };
      return ui;
    })().catch(error => { loading = undefined; throw error; });
    return loading;
  }
  return { load };
}
