/* Host-owned controls using the public header/custom-CSS integration. */
function chartThemeMenu(chartWidget, report) {
  // Obtain the chart document through the public HTML-button API, then release
  // that slot: the native header clones its contents for measuring overflow.
  // An independent button keeps the corner control out of those sizing clones.
  const slot = chartWidget.createButton({align: "left", useTradingViewStyle: false});
  const doc = slot.ownerDocument;
  chartWidget.removeButton(slot);
  const button = doc.createElement("button");
  button.type = "button";
  button.classList.add("mw-chart-menu-button");
  button.setAttribute("role", "button");
  button.setAttribute("tabindex", "0");
  button.setAttribute("aria-label", "图表菜单");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "mw-chart-menu");
  button.setAttribute("title", "图表菜单");
  button.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h16M2 10h16M2 16h16"/></svg>';
  doc.body.appendChild(button);

  const panel = doc.createElement("section");
  panel.id = "mw-chart-menu";
  panel.className = "mw-chart-menu";
  panel.hidden = true;
  panel.setAttribute("aria-label", "图表菜单");
  panel.innerHTML = '<div class="mw-chart-menu-heading">market watch</div>' +
    '<button type="button" class="mw-chart-theme-switch" role="switch" aria-checked="false" aria-label="暗色主题">' +
    '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 2.5a7.5 7.5 0 1 0 4.5 11A7 7 0 0 1 13 2.5Z"/></svg>' +
    '<span>暗色主题</span><span class="mw-chart-switch-track" aria-hidden="true"><span></span></span></button>';
  doc.body.appendChild(panel);
  const toggle = panel.querySelector('[role="switch"]');
  let changing = false;
  const sync = () => {
    const dark = chartWidget.getTheme().toLowerCase() === "dark";
    toggle.setAttribute("aria-checked", String(dark));
    button.dataset.theme = panel.dataset.theme = dark ? "dark" : "light";
  };
  const close = (restoreFocus = false) => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
  };
  const open = () => {
    sync();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    toggle.focus();
  };
  button.addEventListener("click", () => panel.hidden ? open() : close());
  toggle.addEventListener("click", async () => {
    if (changing) return;
    changing = true;
    toggle.disabled = true;
    try {
      await chartWidget.changeTheme(chartWidget.getTheme().toLowerCase() === "dark" ? "Light" : "Dark");
      sync();
    } catch (error) {
      report(error);
    } finally {
      changing = false;
      toggle.disabled = false;
      if (!panel.hidden) toggle.focus();
    }
  });
  doc.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  }, true);
  doc.addEventListener("keydown", (event) => {
    if (!panel.hidden && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }, true);
  doc.addEventListener("focusin", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  });
  chartWidget.subscribe("chart_theme_changed", sync);
  sync();
}
