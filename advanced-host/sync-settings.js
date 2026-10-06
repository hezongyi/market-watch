/* Layout menu extensions and a workspace-scoped draft dialog. */
function chartSyncSettings(
  widget,
  doc,
  mapping,
  coordinator,
  readonly = false,
) {
  let dialog, dialogEpoch, opener, nativeClose, pending, dropdown;
  const cleanups = [];
  function moveFocus(event) {
    event.preventDefault();
    const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),[role="combobox"]')]
      .filter(el => !el.hidden && el.getClientRects().length && el.getAttribute("aria-disabled") !== "true");
    const index = controls.indexOf(doc.activeElement);
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  }
  const modalKeyboard = (event) => {
    if (!dialog) return;
    // The native window owns chart shortcuts. Keep modal keys in the modal.
    event.stopImmediatePropagation();
    if (dropdown) {
      const items = [...dropdown.querySelectorAll('[role="option"]')];
      const index = items.indexOf(doc.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeOptions(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      } else if (["Enter", " "].includes(event.key)) {
        event.preventDefault(); doc.activeElement.click();
      } else if (event.key === "Tab") { closeOptions(true); moveFocus(event); }
      return;
    }
    if (event.key === "Tab") moveFocus(event);
    else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const action = event.target.closest?.('button, [role="combobox"]');
      (action && dialog.contains(action) ? action
        : dialog.querySelector('[data-action="confirm"]')).click();
    } else if (["ArrowDown", "ArrowUp", " "].includes(event.key) && event.target.matches?.('[role="combobox"]')) {
      event.preventDefault(); event.target.click();
    }
  };
  doc.defaultView.addEventListener("keydown", modalKeyboard, true);
  function closeOptions(focus = false) {
    if (!dropdown) return;
    const button = dropdown._opener;
    dropdown.remove(); dropdown = undefined;
    button.setAttribute("aria-expanded", "false");
    if (focus && button.isConnected) button.focus();
  }
  function release() {
    closeOptions(); pending?.disconnect(); pending = undefined;
    dialog = undefined; nativeClose = undefined;
    if (opener?.isConnected) opener.focus();
    opener = undefined;
  }
  function close() {
    if (nativeClose?.isConnected) nativeClose.click();
    release();
  }
  function open(button) {
    close(); mapping.hide(); opener = button;
    // NoticeDialog does not load the native checkbox chunk on its own.
    if (!doc.querySelector('[data-name="mw-native-checkbox-skin"]')) {
      const skin = doc.createElement("link");
      skin.rel = "stylesheet"; skin.dataset.name = "mw-native-checkbox-skin";
      skin.href = new URL((globalThis.MW_CHART_LIBRARY_PATH || "/charting_library/") + "bundles/69437.2948ab6dbdff9ed7521d.css", location.href).href;
      doc.head.appendChild(skin);
    }
    dialogEpoch = coordinator.epoch();
    let draft = mapping.snapshot();
    // Use the actual installed chart modal, including theme, drag, backdrop,
    // focus management, close control and buttons. Only its form is host-owned.
    widget.showNoticeDialog({ title: "同步设置", body: " ", callback: release });
    pending = new MutationObserver(mount);
    pending.observe(doc.body, { childList: true, subtree: true });
    mount();
    function mount() {
      const shell = [...doc.querySelectorAll('[data-name="warning-dialog"]')]
        .find(node => node.querySelector('[class*="title-"]')?.textContent === "同步设置");
      if (!shell || dialog) return;
      pending.disconnect(); pending = undefined;
      dialog = shell;
      shell.dataset.name = "mw-sync-settings-dialog";
      shell.classList.add("mw-sync-settings");
      shell.setAttribute("role", "dialog"); shell.setAttribute("aria-modal", "true");
      const title = shell.querySelector('[class*="title-"]');
      title.id = "mw-sync-settings-title"; shell.setAttribute("aria-labelledby", title.id);
      nativeClose = shell.querySelector('[data-name="close"]');
      nativeClose.dataset.action = "close"; nativeClose.setAttribute("aria-label", "关闭同步设置");
      const content = shell.querySelector('[class*="content-"]'),
        footer = shell.querySelector('[class*="footer-"]'),
        template = footer.querySelector("button");
      const form = doc.createElement("form"); form.className = "mw-sync-settings-form";
      form.innerHTML =
        '<section aria-labelledby="mw-range-appearance"><h3 id="mw-range-appearance">范围映射</h3>' +
        '<label class="mw-setting-row"><span>显示方式</span><select name="style"><option value="background">淡色背景</option><option value="rectangle">高低价矩形</option></select></label>' +
        '<label class="mw-setting-row"><span>填充颜色</span><div class="mw-setting-controls"><select name="colorMode"><option value="theme">主题默认</option><option value="custom">自定义</option></select><input type="color" name="color" aria-label="自定义填充颜色"></div></label>' +
        '<label class="mw-setting-row"><span>透明度</span><select name="transparencyMode"><option value="theme">主题默认</option><option value="custom">自定义</option></select></label>' +
        '<div class="mw-setting-row mw-transparency"><span></span><div class="mw-setting-controls"><input type="range" name="transparencyRange" min="0" max="100" step="1" aria-label="透明度滑块"><label><input type="number" name="transparency" min="0" max="100" step="1" aria-label="透明度百分比">%</label></div></div>' +
        '<label class="mw-label-checkbox checkbox-vyj6oJxw baseline-vyj6oJxw"><span class="wrapper-GZajBGIm"><span class="view-GZajBGIm primary-GZajBGIm"><div class="box-vgla_e5o"><span aria-hidden="true" class="checkedMark-vgla_e5o"><svg width="11" height="9" viewBox="0 0 11 9" fill="none"><path stroke="currentColor" stroke-width="2" d="M1 4L4 7L10 1"/></svg></span></div></span><input class="primary-GZajBGIm input-GZajBGIm" type="checkbox" name="priceLabels"><span class="focusOutline-GZajBGIm"></span></span><span class="label-vyj6oJxw primary-vyj6oJxw">在矩形外侧显示高低价</span></label>' +
        '<div class="mw-range-preview" aria-label="范围映射颜色预览"><span>颜色预览</span></div></section>' +
        '<section class="mw-sync-help"><h3>柱宽同步</h3><p>缩放任一图表，其他图表跟随柱宽变化。</p><p>同步开关位于布局菜单；柱宽与日期范围同步互斥。</p></section>' +
        (readonly ? '<p class="mw-readonly-note">当前为只读视图，调整不会保存到工作区。</p>' : '');
      form.querySelector('.checkedMark-vgla_e5o svg').style.display = "block";
      content.replaceChildren(form);
      const field = name => form.elements.namedItem(name);
      const combos = new Map();
      for (const select of form.querySelectorAll("select")) {
        const wrapper = doc.createElement("span");
        wrapper.className = "mw-native-select";
        const control = doc.createElement("span");
        control.className = "container-WDZ0PRNh container-small-WDZ0PRNh intent-default-WDZ0PRNh border-thin-WDZ0PRNh size-small-WDZ0PRNh adjust-position-WDZ0PRNh first-row-WDZ0PRNh first-col-WDZ0PRNh button-tFul0OhX dropdown-RxdEkbF0 normal-RxdEkbF0";
        control.setAttribute("role", "combobox"); control.tabIndex = 0;
        control.setAttribute("aria-label", select.closest("label").querySelector("span").textContent);
        control.setAttribute("aria-haspopup", "listbox"); control.setAttribute("aria-expanded", "false");
        control.innerHTML = '<span class="mw-native-select-text"></span><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18"><path fill="none" stroke="currentColor" d="m4 7 5 5 5-5"/></svg>';
        select.before(wrapper); wrapper.append(select, control);
        select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
        combos.set(select, control);
        control.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          if (select.disabled) return;
          if (dropdown?._opener === control) { closeOptions(true); return; }
          closeOptions();
          dropdown = doc.createElement("div");
          dropdown.className = "menuWrap-Kq3ruQo8 mw-sync-options";
          dropdown.dataset.name = "mw-sync-options"; dropdown.setAttribute("role", "listbox");
          dropdown.setAttribute("aria-label", control.getAttribute("aria-label")); dropdown._opener = control;
          for (const option of select.options) {
            const item = doc.createElement("div");
            item.className = "item-jFqVJoPk" + (select.value === option.value ? " isActive-jFqVJoPk" : "");
            item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(select.value === option.value)); item.tabIndex = -1;
            item.innerHTML = '<span class="labelRow-jFqVJoPk"><span class="label-jFqVJoPk"></span></span>';
            item.firstElementChild.firstElementChild.textContent = option.text;
            item.addEventListener("click", event => {
              event.preventDefault(); event.stopPropagation();
              select.value = option.value;
              select.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
              closeOptions(true);
            });
            dropdown.appendChild(item);
          }
          // Keep options inside the native modal's click/focus boundary.
          // A body portal is treated as an outside click by NoticeDialog.
          dialog.appendChild(dropdown);
          const bounds = control.getBoundingClientRect(), shellBounds = dialog.getBoundingClientRect();
          dropdown.style.left = bounds.left-shellBounds.left + "px"; dropdown.style.minWidth = bounds.width + "px";
          dropdown.style.top = Math.min(bounds.bottom + 4, doc.defaultView.innerHeight - dropdown.offsetHeight - 8)-shellBounds.top + "px";
          control.setAttribute("aria-expanded", "true");
          dropdown.querySelector('[aria-selected="true"]').focus();
        });
      }
      const number = field("transparency"), numberWrap = doc.createElement("span");
      numberWrap.className = "container-WDZ0PRNh container-small-WDZ0PRNh intent-default-WDZ0PRNh border-thin-WDZ0PRNh size-small-WDZ0PRNh mw-native-number";
      number.className = "input-RUSovanF size-small-RUSovanF";
      number.before(numberWrap); numberWrap.appendChild(number);
      function reflect() {
        for (const k of ["style", "colorMode", "color", "transparencyMode", "transparency"]) field(k).value = draft[k];
        field("transparencyRange").value = draft.transparency;
        field("priceLabels").checked = draft.priceLabels;
        field("priceLabels").disabled = draft.style !== "rectangle";
        field("priceLabels").setAttribute("aria-checked", String(draft.priceLabels));
        const checkbox = shell.querySelector(".mw-label-checkbox");
        checkbox.style.opacity = draft.style === "rectangle" ? "1" : ".45";
        const box = checkbox.querySelector(".box-vgla_e5o");
        box.classList.toggle("checked-vgla_e5o", draft.priceLabels);
        box.classList.toggle("unchecked-vgla_e5o", !draft.priceLabels);
        box.firstElementChild.hidden = !draft.priceLabels;
        field("color").disabled = draft.colorMode !== "custom";
        for (const k of ["transparencyRange", "transparency"]) field(k).disabled = draft.transparencyMode !== "custom";
        for (const [select, control] of combos) {
          control.firstElementChild.textContent = select.selectedOptions[0].text;
          control.setAttribute("aria-disabled", String(select.disabled));
        }
        const dark = widget.getTheme().toLowerCase() === "dark";
        const effective = { ...draft };
        if (draft.colorMode === "theme") effective.color = dark ? "#5A91FF" : "#2962FF";
        if (draft.transparencyMode === "theme") effective.transparency = dark ? 82 : 88;
        field("color").value = effective.color;
        field("transparency").value = field("transparencyRange").value = effective.transparency;
        shell.querySelector(".mw-range-preview").style.background = mapping.fillColor(draft);
      }
      form.addEventListener("input", event => {
        const el = event.target, k = el.name;
        if (k === "transparencyRange" || k === "transparency") {
          if (el.value === "" || !Number.isFinite(Number(el.value))) return;
          draft.transparency = Math.max(0, Math.min(100, Number(el.value))); draft.transparencyMode = "custom";
        } else if (k === "priceLabels") draft.priceLabels = el.checked;
        else if (k in draft) draft[k] = el.value;
        reflect();
      });
      const confirm = event => {
        event.preventDefault(); event.stopPropagation();
        if (dialogEpoch !== coordinator.epoch()) { close(); return; }
        if (!form.reportValidity()) return;
        mapping.configure(draft); close();
      };
      form.addEventListener("submit", confirm);
      const action = (text, name, handler, primary = false) => {
        const node = template.cloneNode(true); node.type = "button";
        for (const attr of ["name", "data-qa-id", "data-overflow-tooltip-text"]) node.removeAttribute(attr);
        node.dataset.action = name;
        node.querySelector('[class*="content-"]').textContent = text;
        node.classList.toggle("primary-D4RPB3ZC", primary); node.classList.toggle("secondary-D4RPB3ZC", !primary);
        node.addEventListener("click", handler); return node;
      };
      footer.replaceChildren(
        action("恢复默认", "defaults", () => { draft = { ...mapping.defaults(), enabled: draft.enabled }; reflect(); }),
        action("取消", "cancel", close), action("确定", "confirm", confirm, true));
      form.appendChild(footer);
      shell._mwReflect = reflect;
      reflect();
      doc.defaultView.requestAnimationFrame(() => {
        if (!shell.isConnected) return;
        const outer = shell.parentElement;
        outer.style.transform = `translate(${Math.max(8, (doc.defaultView.innerWidth - outer.offsetWidth) / 2)}px, ${Math.max(8, (doc.defaultView.innerHeight - outer.offsetHeight) / 2)}px)`;
        combos.get(field("style")).focus();
      });
    }
  }
  const outsideOptions = event => {
    if (dropdown && !dropdown.contains(event.target) && !dropdown._opener.contains(event.target)) closeOptions();
  };
  doc.addEventListener("pointerdown", outsideOptions, true);
  const dismissOptions = () => closeOptions();
  doc.addEventListener("scroll", dismissOptions, true);
  doc.defaultView.addEventListener("resize", dismissOptions);
  cleanups.push(() => {
    doc.removeEventListener("pointerdown", outsideOptions, true);
    doc.removeEventListener("scroll", dismissOptions, true);
    doc.defaultView.removeEventListener("resize", dismissOptions);
  });
  function extend() {
    const crosshair = doc.querySelector('input[value="syncCrosshairLabel"]'),
      row = crosshair?.closest('[data-role="menuitem"]');
    if (!row) return;
    const container = row.parentElement;
    const createRow = (name, label, anchor) => {
      let entry = container.querySelector(`[data-name="${name}"]`);
      if (entry) return entry;
      entry = row.cloneNode(true);
      entry.dataset.name = name;
      entry.removeAttribute("data-role");
      entry.removeAttribute("aria-selected");
      entry.setAttribute("role", "switch");
      entry.tabIndex = 0;
      entry.setAttribute("aria-label", label);
      entry.querySelector('[role="rowheader"]').textContent = label;
      const info = entry.querySelector('[role="cell"]');
      const purpose = name === "mw-bar-range-mapping"
        ? "将鼠标所在K线的真实时间范围映射到同品种的小周期图表；高低价显示在矩形外侧对应极值K线的位置。需开启十字线同步。"
        : "缩放任一图表时，其他图表跟随柱宽变化；支持滚轮、缩放按钮和快捷键。与日期范围同步互斥。";
      info.title = purpose;
      info.setAttribute("data-tooltip", purpose);
      info.setAttribute("aria-label", purpose);
      info.dataset.name = name + "-help";
      info.setAttribute("data-tooltip-show-on-focus", "true");
      info.tabIndex = 0;
      info.setAttribute("role", "button");
      // The native hover delegate also handles focus, but mixed pointer and
      // keyboard entry can retain its hover listener after focus leaves.
      info.addEventListener("blur", () => info.dispatchEvent(new doc.defaultView.MouseEvent("mouseleave")));
      info.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      });
      info.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
      const input = entry.querySelector("input");
      input.removeAttribute("value");
      input.removeAttribute("id");
      input.removeAttribute("role");
      input.removeAttribute("aria-checked");
      input.removeAttribute("aria-disabled");
      input.setAttribute("aria-hidden", "true");
      input.tabIndex = -1;
      // A stable CSS skin uses the real checkbox state; no stale React class or
      // custom knob transform competes with the installed native skin.
      entry.classList.add("mw-sync-row");
      anchor.after(entry);
      const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (entry.getAttribute("aria-disabled") === "true") return;
        if (name === "mw-bar-range-mapping")
          mapping.configure({ enabled: !mapping.snapshot().enabled });
        else coordinator.select("barWidth", !coordinator.snapshot().barWidth);
      };
      entry.addEventListener("click", activate);
      entry.addEventListener("keydown", (e) => {
        if (["Enter", " "].includes(e.key)) activate(e);
      });
      return entry;
    };
    createRow("mw-bar-range-mapping", "范围映射", row);
    const date = container
      .querySelector('input[value="syncDateRangeLabel"]')
      ?.closest('[data-role="menuitem"]');
    createRow("mw-bar-width-sync", "柱宽同步", date || row);
    if (!container.querySelector('[data-name="mw-sync-settings"]')) {
      const separator = doc.createElement("div");
      separator.className = "mw-sync-settings-separator";
      separator.setAttribute("role", "separator");
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.name = "mw-sync-settings";
      button.className = row.className + " mw-sync-settings-entry";
      button.classList.remove("switcher-aGeQPIIx");
      button.style.color = doc.defaultView.getComputedStyle(row.querySelector('[role="rowheader"]')).color;
      button.textContent = "同步设置";
      button.setAttribute("aria-haspopup", "dialog");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        widget.closePopupsAndDialogs();
        open(button);
      });
      container.append(separator, button);
    }
    reflectMenu();
  }
  const setAttr = (el, k, v) => {
    if (el?.getAttribute(k) !== String(v)) el?.setAttribute(k, String(v));
  };
  function reflectMenu() {
    if (dialog && !dialog.isConnected) release();
    if (dialog && dialogEpoch !== coordinator.epoch()) close();
    const state = coordinator.snapshot(),
      config = mapping.snapshot();
    const settingsButton = doc.querySelector('[data-name="mw-sync-settings"]');
    const nativeLabel = doc.querySelector('input[value="syncCrosshairLabel"]')?.closest('[data-role="menuitem"]')?.querySelector('[role="rowheader"]');
    if (settingsButton && nativeLabel) settingsButton.style.color = doc.defaultView.getComputedStyle(nativeLabel).color;
    for (const [name, enabled, disabled, title] of [
      [
        "mw-bar-range-mapping",
        config.enabled,
        !widget.crosshairSync().value(),
        "需开启十字线同步",
      ],
      ["mw-bar-width-sync", state.barWidth, state.date, "需先关闭日期范围同步"],
    ]) {
      const el = doc.querySelector(`[data-name="${name}"]`);
      if (!el) continue;
      setAttr(el, "aria-checked", enabled);
      setAttr(el, "aria-disabled", disabled);
      const input = el.querySelector("input");
      input.checked = enabled;
      input.disabled = disabled;
      for (const e of [
        input,
        ...el.querySelectorAll('[class*="switchView-"]'),
      ]) {
        for (const k of [...e.classList])
          if (k.startsWith("checked-")) e.classList.remove(k);
        if (enabled) {
          const suffix = [...e.classList]
            .find((k) => /^(input|switchView)-/.test(k))
            ?.split("-")
            .slice(1)
            .join("-");
          if (suffix) e.classList.add("checked-" + suffix);
        }
      }
      el.title = disabled
        ? title
        : name === "mw-bar-width-sync"
          ? "用户实际缩放的图表带动其他图"
          : "将所选时段映射到更小周期";
    }
    for (const [key, selector] of [
      ["date", "syncDateRangeLabel"],
      ["time", "syncTrackLabel"],
    ]) {
      const input = doc.querySelector(`input[value="${selector}"]`),
        row = input?.closest('[data-role="menuitem"]');
      if (!row) continue;
      const disabled = key === "date" && state.barWidth;
      setAttr(row, "aria-disabled", disabled);
      setAttr(row, "aria-checked", state[key]);
      input.disabled = disabled;
      input.checked = state[key];
      setAttr(input, "aria-disabled", disabled);
      setAttr(input, "aria-checked", state[key]);
      for (const e of [input, ...row.querySelectorAll('[class*="switchView-"]')]) {
        const suffix = [...e.classList]
          .find(k => /^(input|switchView)-/.test(k))?.split('-').slice(1).join('-');
        if (suffix) e.classList.toggle('checked-' + suffix, state[key]);
      }
      row.title = disabled ? "需先关闭柱宽同步" : "";
      row.classList.toggle("mw-sync-disabled", disabled);
    }
  }
  const selectNativeSync = (event) => {
    const row = event.target.closest?.('[data-role="menuitem"]');
    const key = row?.querySelector('input[value="syncDateRangeLabel"]') ? "date"
      : row?.querySelector('input[value="syncTrackLabel"]') ? "time" : undefined;
    if (!key || (event.type !== "click" && !["Enter", " "].includes(event.key))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    coordinator.select(key, !coordinator.snapshot()[key]);
  };
  doc.addEventListener("click", selectNativeSync, true);
  doc.addEventListener("keydown", selectNativeSync, true);
  const observer = new MutationObserver(extend);
  observer.observe(doc.body, { childList: true, subtree: true });
  cleanups.push(
    mapping.subscribe(reflectMenu),
    coordinator.subscribe(() => {reflectMenu();doc.defaultView.requestAnimationFrame(reflectMenu);}),
  );
  const themeChanged = () => { reflectMenu(); dialog?._mwReflect?.(); };
  widget.subscribe("chart_theme_changed", themeChanged);
  const crosshairChanged = () => reflectMenu();
  widget.crosshairSync().subscribe(crosshairChanged);
  widget.subscribe("chart_load_requested", close);
  extend();
  return {
    dispose() {
      close();
      observer.disconnect();
      doc.defaultView.removeEventListener("keydown", modalKeyboard, true);
      cleanups.forEach((fn) => fn());
      widget.crosshairSync().unsubscribe(crosshairChanged);
      widget.unsubscribe("chart_load_requested", close);
      widget.unsubscribe("chart_theme_changed", themeChanged);
      doc.removeEventListener("click", selectNativeSync, true);
      doc.removeEventListener("keydown", selectNativeSync, true);
    },
  };
}
