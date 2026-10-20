/* The pinned library owns the template icon, menus and save/overwrite/delete UI.
 * Enabling header_indicators mounts its Templates component too. Keep our richer
 * indicator picker, hiding only the duplicate native indicator selector.
 */
function chartStudyTemplates(widget, _templates, _readonly, report) {
  if (
    !globalThis.TradingView?.version?.().includes(
      "6b804c486857f27920cf761aa7eb6e29d9bb6362",
    )
  ) {
    report(Error("原生指标模板入口版本尚未适配"));
    return { dispose() {} };
  }
  const probe = widget.createButton({
    align: "left",
    useTradingViewStyle: false,
  });
  const doc = probe.ownerDocument;
  widget.removeButton(probe);
  const style = doc.createElement("style");
  style.textContent = "#header-toolbar-indicators{display:none}";
  doc.head.append(style);
  return {
    dispose() {
      style.remove();
    },
  };
}
