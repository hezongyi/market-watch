/* The only adapter to the installed, version-pinned native UI implementation.
 * No chart-properties renderer, model or undo checkpoint is used here.
 */
function chartNativeUi(widget, doc) {
  const expected = "6b804c486857f27920cf761aa7eb6e29d9bb6362";
  const win = doc.defaultView;
  let loading;
  async function load() {
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
      const components = {
        dialog: req(450259).AdaptivePopupDialog,
        sidebar: req(649867).DialogSidebarWrapper,
        sidebarItem: req(649867).DialogSidebarItem,
        search: req(357723).DialogSearch,
        input: req(909536).InputControl,
        checkbox: req(343577).Checkbox,
        select: req(221339).Select,
      };
      for (const [name, component] of Object.entries(components))
        if (!component) throw Error(`原生控件不可用：${name}`);
      function mount(kind, node, props) {
        const component = components[kind];
        if (!component) throw Error("未知原生控件");
        node.dataset.nativeComponent = kind;
        const element = value => kind === "sidebar" ? R.createElement(component, {className:value.className},
          R.createElement("div", {ref:value.contentRef})) : R.createElement(component, value);
        let root = createRoot(element(props), node);
        return { update(next) { root?.render(element(next)); },
          dispose() { root?.unmount(); root = null; delete node.dataset.nativeComponent; } };
      }
      const popupCancels=new Set();
      return { mount, components, react: R, createRoot,
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
    })().catch(error => { loading = undefined; throw error; });
    return loading;
  }
  return { load };
}
