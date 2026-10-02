/* Host-owned controls using the public header/custom-CSS integration. */
function chartThemeMenu(chartWidget, report, grid, actions, createWorkspace, autoSave) {
  // Obtain the chart document through the public HTML-button API, then release
  // that slot: the native header clones its contents for measuring overflow.
  // An independent button keeps the corner control out of those sizing clones.
  const slot = chartWidget.createButton({align: "left", useTradingViewStyle: false});
  const doc = slot.ownerDocument;
  chartWidget.removeButton(slot);
  // Native layout menus are recreated on each open. Extend their existing
  // data-name markup without replacing save/copy/rename/load handlers.
  if (createWorkspace) {
    const newEntry = save => {
      const entry = save.cloneNode(true);
      entry.removeAttribute("aria-disabled");
      entry.removeAttribute("disabled");
      for (const name of [...entry.classList])
        if (/^isDisabled-/.test(name)) entry.classList.remove(name);
      return entry;
    };
    const extendLayoutMenu = () => {
      const save = doc.querySelector('[data-name="save-load-menu-item-save"]');
      const container = save?.parentElement;
      if (!container) return;
      if (!container.querySelector('[data-name="mw-layout-create"]')) {
        const entry = newEntry(save);
        entry.dataset.name = "mw-layout-create";
        entry.setAttribute("aria-haspopup", "dialog");
        entry.setAttribute("tabindex", "0");
        entry.title = "保存当前工作区并新建空白工作区";
        const label = entry.firstElementChild;
        entry.replaceChildren(label);
        label.firstElementChild.textContent = "新建工作区";
        const activate = async event => {
          event.preventDefault();
          event.stopPropagation();
          doc.querySelector('[data-name="save-load-menu"]')?.click();
          try { await createWorkspace(); } catch (error) { report(error); }
        };
        entry.addEventListener("click", activate);
        entry.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") activate(event);
        });
        save.after(entry);
      }
      if (!container.querySelector('[data-name="mw-layout-autosave"]')) {
        const entry = newEntry(save);
        entry.dataset.name = "mw-layout-autosave";
        entry.classList.add("mw-layout-autosave");
        entry.setAttribute("role", "switch");
        entry.setAttribute("aria-label", "自动保存");
        entry.setAttribute("tabindex", "0");
        entry.title = "开启后每30秒保存有更改的布局";
        entry.innerHTML = '<span class="mw-layout-autosave-label">自动保存<small>30秒</small></span>' +
          '<span class="mw-chart-switch-track" aria-hidden="true"><span></span></span>';
        let busy = false;
        const sync = () => {
          entry.setAttribute("aria-checked", String(autoSave.enabled));
          entry.setAttribute("aria-disabled", String(busy));
        };
        const activate = async event => {
          event.preventDefault();
          event.stopPropagation();
          if (busy) return;
          busy = true;
          sync();
          try { await autoSave.select(!autoSave.enabled); } catch (error) { report(error); }
          finally { busy = false; sync(); }
        };
        entry.addEventListener("click", activate);
        entry.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") activate(event);
        });
        container.querySelector('[data-name="mw-layout-create"]').after(entry);
        sync();
      }
    };
    const observer = new MutationObserver(extendLayoutMenu);
    observer.observe(doc.body, {childList: true, subtree: true});
    extendLayoutMenu();
    doc.defaultView.addEventListener("pagehide", () => observer.disconnect(), {once: true});
  }
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
  // Same Lucide Waves paths and two-line wordmark as the homepage brand.
  panel.innerHTML = '<div class="mw-chart-menu-heading"><div class="mw-chart-menu-brand">' +
    '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>' +
    '<path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>' +
    '<path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>' +
    '</svg><span>守望<small>MARKET WATCH</small></span></div></div>' +
    '<button type="button" class="mw-chart-theme-switch" role="switch" aria-checked="false" aria-label="暗色主题">' +
    '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 2.5a7.5 7.5 0 1 0 4.5 11A7 7 0 0 1 13 2.5Z"/></svg>' +
    '<span>暗色主题</span><span class="mw-chart-switch-track" aria-hidden="true"><span></span></span></button>' +
    '<label class="mw-chart-grid-style"><span>网格线</span>' +
    '<select aria-label="网格线样式"><option value="dotted">点线</option><option value="solid">实线</option></select></label>';
  doc.body.appendChild(panel);
  const toggle = panel.querySelector('[role="switch"]');
  const gridSelect = panel.querySelector('select');
  gridSelect.value = grid.value;
  gridSelect.disabled = grid.readonly;
  gridSelect.addEventListener("change", async () => {
    gridSelect.disabled = true;
    try {
      await grid.select(gridSelect.value);
    } catch (error) {
      report(error);
    } finally {
      gridSelect.value = grid.value;
      gridSelect.disabled = grid.readonly;
    }
  });
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
  for (const action of actions) {
    const entry = doc.createElement("button");
    entry.type = "button";
    entry.className = "mw-chart-menu-action";
    entry.textContent = action.label;
    entry.title = action.title || action.label;
    if (action.recovery) {
      entry.dataset.recovery = "true";
      entry.hidden = true;
    }
    entry.addEventListener("click", async () => {
      close(true);
      try { await action.run(); } catch (error) { report(error); }
    });
    panel.appendChild(entry);
  }
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
  return {setDraftBlocked(blocked) {
    for (const entry of panel.querySelectorAll('[data-recovery="true"]'))
      entry.hidden = !blocked;
  }};
}
