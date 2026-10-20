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
  // Keep React ownership of the native template/menu intact. Flex order moves
  // its existing toolbar group after our indicator picker, including fake
  // measurement toolbars and groups recreated by responsive header updates.
  const originalOrders = new Map();
  const hiddenSeparators = new Set();
  function positionTemplates() {
    for (const toolbar of doc.querySelectorAll(".innerWrap-OhqNVIYA")) {
      const indicator = toolbar.querySelector(".mw-indicator-button");
      const templates = toolbar.querySelector("#header-toolbar-study-templates");
      const templateButton = templates ||
        toolbar.querySelector('button[aria-label="指标模板"]');
      const indicatorGroup = indicator?.closest(".group-MBOVGQRI");
      const templateGroup = templateButton?.closest(".group-MBOVGQRI");
      if (!indicatorGroup || !templateGroup || indicatorGroup === templateGroup)
        continue;
      const children = Array.from(toolbar.children);
      if (!children.includes(indicatorGroup) || !children.includes(templateGroup))
        continue;
      children.forEach((child, index) => {
        if (!originalOrders.has(child))
          originalOrders.set(child, child.style.order);
        child.style.order = String(index * 2);
      });
      templateGroup.style.order = String(children.indexOf(indicatorGroup) * 2 + 1);
      const separator = templateGroup.previousElementSibling;
      if (separator?.classList.contains("separatorWrap-MBOVGQRI")) {
        separator.classList.add("mw-template-separator");
        hiddenSeparators.add(separator);
      }
    }
  }
  style.textContent += ".mw-template-separator{display:none}";
  const observer = new MutationObserver((records) => {
    if (records.some((record) =>
      record.target.closest?.(".toolbar-qqNP9X6e,.innerWrap-OhqNVIYA") ||
      Array.from(record.addedNodes).some((node) =>
        node.matches?.(".innerWrap-OhqNVIYA") ||
        node.querySelector?.(".innerWrap-OhqNVIYA"),
      ),
    )) positionTemplates();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  positionTemplates();
  return {
    dispose() {
      observer.disconnect();
      for (const [node, order] of originalOrders) node.style.order = order;
      for (const node of hiddenSeparators)
        node.classList.remove("mw-template-separator");
      style.remove();
    },
  };
}
