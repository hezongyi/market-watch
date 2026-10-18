/* Host-owned controls using the public header/custom-CSS integration. */
function chartThemeMenu(chartWidget, report, grid, actions, createWorkspace, autoSave, saveLayout, changePassword, barRangeMapping, syncCoordinator) {
  // Obtain the chart document through the public HTML-button API, then release
  // that slot: the native header clones its contents for measuring overflow.
  // An independent button keeps the corner control out of those sizing clones.
  const slot = chartWidget.createButton({align: "left", useTradingViewStyle: false});
  const doc = slot.ownerDocument;
  chartWidget.removeButton(slot);
  // Native save shortcuts can be disabled for host-owned viewport/grid edits.
  // Use the same save pipeline for all edits, once per keypress.
  doc.addEventListener("keydown", event => {
    if (!saveLayout || grid.readonly || !(event.ctrlKey || event.metaKey) ||
        event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    saveLayout();
  }, true);
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
        const rename = container.querySelector('[data-name="save-load-menu-item-rename"]');
        (rename || save).after(entry);
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
        save.after(entry);
        sync();
      }
    };
    const observer = new MutationObserver(extendLayoutMenu);
    observer.observe(doc.body, {childList: true, subtree: true});
    extendLayoutMenu();
    doc.defaultView.addEventListener("pagehide", () => observer.disconnect(), {once: true});
  }
  if (barRangeMapping && syncCoordinator) {
    const syncSettings=chartSyncSettings(chartWidget,doc,barRangeMapping,syncCoordinator,grid.readonly);
    doc.defaultView.addEventListener('pagehide',()=>syncSettings.dispose(),{once:true});
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
    '';
  doc.body.appendChild(panel);
  const toggle = panel.querySelector('[role="switch"]');
  // Native settings have no public field-extension API. Extend their stable
  // gridLines markup with host-owned cells, preserving native handlers.
  let settingsSession;
  const extendGridSettings = () => {
    if (settingsSession && !settingsSession.dialog.isConnected) {
      settingsSession.closeOptions?.();
      if (!settingsSession.accepted) grid.preview();
      settingsSession = undefined;
    }
    const dialog = doc.querySelector('[data-name="series-properties-dialog"]');
    if (!dialog) return;
    if (!settingsSession) {
      const session = settingsSession = {dialog, initial: grid.value, accepted: false};
      grid.beginPreview();
      dialog.addEventListener("click", event => {
        if (!event.target.closest('[data-name="submit-button"]')) return;
        session.accepted = true;
        if (grid.displayValue !== session.initial)
          grid.select(grid.displayValue).catch(error => {grid.preview(); report(error);});
        else grid.preview();
      }, true);
    }
    const cells = dialog.querySelectorAll('[data-qa-id="property-dialog-item gridLines"]');
    if (cells.length !== 2) return;
    const parent = cells[0].parentElement;
    if (parent.querySelector('[data-name="mw-grid-style-label"]')) return;
    const labelCell = cells[0].cloneNode(true);
    const controlCell = cells[1].cloneNode(true);
    for (const cell of [labelCell, controlCell]) cell.removeAttribute("data-qa-id");
    labelCell.dataset.name = "mw-grid-style-label";
    controlCell.dataset.name = "mw-grid-style-control";
    const label = labelCell.querySelector('span');
    label.textContent = "网格线样式";
    label.id = "mw-grid-style-label";
    const inner = controlCell.firstElementChild;
    inner.replaceChildren();
    const nativeButton = cells[1].querySelector('[data-name="options-dropdown"]');
    const select = nativeButton.cloneNode(true);
    select.id = "mw-grid-style-select";
    select.dataset.name = "mw-grid-style-select";
    select.removeAttribute("data-qa-id");
    select.setAttribute("role", "combobox");
    select.setAttribute("aria-labelledby", label.id);
    select.setAttribute("aria-controls", "mw-grid-style-options");
    select.setAttribute("aria-expanded", "false");
    select.setAttribute("aria-disabled", String(grid.readonly));
    select.classList.add("mw-grid-style-select");
    select.style.width = doc.defaultView.getComputedStyle(nativeButton).width;
    const text = select.querySelector('[class*="button-children-"] > span');
    select.dataset.value = grid.displayValue;
    text.textContent = grid.displayValue === "solid" ? "实线" : "点线";
    let popup, popupEvents;
    const closeOptions = (focus = false) => {
      popupEvents?.abort();
      popupEvents = undefined;
      popup?.remove();
      popup = undefined;
      select.setAttribute("aria-expanded", "false");
      if (focus) select.focus();
    };
    const openOptions = () => {
      if (grid.readonly) return;
      if (popup) {closeOptions(); return;}
      popup = doc.createElement("div");
      popup.id = "mw-grid-style-options";
      popup.className = "menuWrap-Kq3ruQo8 mw-grid-style-options";
      popup.setAttribute("role", "listbox");
      popup.setAttribute("aria-labelledby", label.id);
      const box = doc.createElement("div");
      box.className = "menuBox-Kq3ruQo8";
      popup.appendChild(box);
      for (const [value, title] of [["dotted", "点线"], ["solid", "实线"]]) {
        const option = doc.createElement("div");
        option.className = "item-jFqVJoPk" + (value === grid.displayValue ? " isActive-jFqVJoPk" : "");
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(value === grid.displayValue));
        option.tabIndex = -1;
        option.innerHTML = '<span class="labelRow-jFqVJoPk"><span class="label-jFqVJoPk"></span></span>';
        option.firstElementChild.firstElementChild.textContent = title;
        const choose = () => { grid.preview(value); closeOptions(true); };
        option.addEventListener("click", choose);
        option.addEventListener("keydown", event => {
          if (["Enter", " "].includes(event.key)) {event.preventDefault();event.stopPropagation();choose();}
        });
        box.appendChild(option);
      }
      // Settings panels use transforms, which change fixed-position origins.
      // Keep this popup in the document overlay layer, using viewport bounds.
      doc.body.appendChild(popup);
      popupEvents = new doc.defaultView.AbortController();
      const options = {capture: true, signal: popupEvents.signal};
      doc.addEventListener("keydown", navigateOptions, options);
      doc.addEventListener("pointerdown", event => {
        if (!popup.contains(event.target) && !select.contains(event.target)) closeOptions();
      }, options);
      doc.addEventListener("scroll", () => closeOptions(), options);
      doc.defaultView.addEventListener("resize", () => closeOptions(), {signal: popupEvents.signal});
      const bounds = select.getBoundingClientRect();
      popup.style.left = bounds.left + "px";
      popup.style.width = bounds.width + "px";
      popup.style.top = (bounds.bottom + 4) + "px";
      if (popup.getBoundingClientRect().bottom > doc.defaultView.innerHeight - 8)
        popup.style.top = (bounds.top - popup.offsetHeight - 4) + "px";
      select.setAttribute("aria-expanded", "true");
      popup.querySelector('[aria-selected="true"]').focus();
    };
    select.addEventListener("click", openOptions);
    select.addEventListener("keydown", event => {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); openOptions();
      }
    });
    const navigateOptions = event => {
      if (!popup) return;
      if (event.key === "Escape") {event.preventDefault();event.stopPropagation();closeOptions(true);}
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const options = [...popup.querySelectorAll('[role="option"]')];
        const index = options.indexOf(doc.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
          (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      } else if (event.key === "Tab") closeOptions();
    };
    settingsSession.closeOptions = closeOptions;
    inner.appendChild(select);
    cells[1].after(labelCell, controlCell);
  };
  grid.subscribe(value => {
    const select = doc.querySelector(".mw-grid-style-select");
    if (select) {
      select.dataset.value = value;
      select.querySelector('[class*="button-children-"] > span').textContent = value === "solid" ? "实线" : "点线";
    }
  });
  const renameWatchlistHeader = () => {
    const header = doc.querySelector('button[data-column-type="short_name"]');
    if (header?.textContent === "商品代码") header.textContent = "商品";
  };
  const settingsObserver = new MutationObserver(() => {extendGridSettings(); renameWatchlistHeader();});
  settingsObserver.observe(doc.body, {childList: true, subtree: true});
  extendGridSettings();
  renameWatchlistHeader();
  doc.defaultView.addEventListener("pagehide", () => settingsObserver.disconnect(), {once: true});
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
    if (action.action) entry.dataset.appAction = action.action;
    entry.className = "mw-chart-menu-action item-jFqVJoPk";
    entry.innerHTML = '<span class="labelRow-jFqVJoPk"><span class="label-jFqVJoPk"></span></span>';
    entry.firstElementChild.firstElementChild.textContent = action.label;
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
  return {
    setPending(count) {
      const entry = panel.querySelector('[data-app-action="signals"] .label-jFqVJoPk');
      if (entry) entry.textContent = "通知" + (Number.isSafeInteger(count) && count > 0 ? `（${count} 未读）` : "");
    },
    changePassword: () => chartPasswordDialog(chartWidget, doc, changePassword, report),
    setDraftBlocked(blocked) {
    for (const entry of panel.querySelectorAll('[data-recovery="true"]'))
      entry.hidden = !blocked;
  }};
}
