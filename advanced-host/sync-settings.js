/* Layout menu extensions and a workspace-scoped draft dialog. */
function chartSyncSettings(
  widget,
  doc,
  mapping,
  coordinator,
  readonly = false,
) {
  let dialog, dialogEpoch, opener;
  const cleanups = [];
  const modalKeyboard = (event) => {
    if (!dialog) return;
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Native chart shortcuts must not consume modal Enter, but focused
      // buttons retain their own action (especially Cancel and Defaults).
      const button = event.target.closest?.("button");
      (button && dialog.contains(button)
        ? button
        : dialog.querySelector('[data-action="confirm"]')).click();
    }
  };
  // The library consumes Escape/Enter in its document keyboard manager.
  // Intercept on the native window while our modal owns keyboard focus.
  doc.defaultView.addEventListener("keydown", modalKeyboard, true);
  function close() {
    dialog?.remove();
    dialog = undefined;
    if (opener?.isConnected) opener.focus();
    opener = undefined;
  }
  function open(button) {
    close();
    mapping.hide();
    opener = button;
    dialogEpoch = coordinator.epoch();
    let draft = mapping.snapshot();
    dialog = doc.createElement("dialog");
    dialog.className = "mw-sync-settings";
    dialog.dataset.name = "mw-sync-settings-dialog";
    dialog.setAttribute("aria-labelledby", "mw-sync-settings-title");
    dialog.innerHTML =
      '<form method="dialog"><header><h2 id="mw-sync-settings-title">同步设置</h2><button type="button" data-action="close" aria-label="关闭同步设置">×</button></header>' +
      "<fieldset><legend>范围映射</legend>" +
      '<label>显示方式<select name="style"><option value="background">淡色背景</option><option value="rectangle">高低价矩形</option></select></label>' +
      '<label>填充颜色<select name="colorMode"><option value="theme">跟随主题</option><option value="custom">自定义</option></select><input type="color" name="color" aria-label="自定义填充颜色"></label>' +
      '<label>透明度<select name="transparencyMode"><option value="theme">主题默认</option><option value="custom">自定义</option></select></label>' +
      '<div class="mw-transparency"><input type="range" name="transparencyRange" min="0" max="100" step="1" aria-label="透明度滑块"><label><input type="number" name="transparency" min="0" max="100" step="1" aria-label="透明度百分比">%</label></div>' +
      '<label class="mw-label-checkbox"><input type="checkbox" name="priceLabels">显示高低价</label>' +
      '<div class="mw-range-preview" aria-label="范围映射颜色预览"><span>颜色预览</span></div></fieldset>' +
      "<p>柱宽同步：用户在图表上通过滚轮、按钮或快捷键缩放时，其他图跟随。与日期范围同步互斥。</p>" +
      (readonly ? "<p>当前为只读视图，调整不会保存到工作区。</p>" : "") +
      '<footer><button type="button" data-action="defaults">恢复默认</button><span></span><button type="button" data-action="cancel">取消</button><button type="button" data-action="confirm">确定</button></footer></form>';
    const form = dialog.querySelector("form"),
      field = (name) => form.elements.namedItem(name);
    function reflect() {
      for (const k of [
        "style",
        "colorMode",
        "color",
        "transparencyMode",
        "transparency",
      ])
        field(k).value = draft[k];
      field("transparencyRange").value = draft.transparency;
      field("priceLabels").checked = draft.priceLabels;
      field("priceLabels").disabled = draft.style !== "rectangle";
      field("color").disabled = draft.colorMode !== "custom";
      for (const k of ["transparencyRange", "transparency"])
        field(k).disabled = draft.transparencyMode !== "custom";
      const dark = widget.getTheme().toLowerCase() === "dark";
      dialog.querySelector(".mw-range-preview").style.background =
        mapping.fillColor(draft);
      dialog.dataset.theme = dark ? "dark" : "light";
    }
    form.addEventListener("input", (event) => {
      const el = event.target,
        k = el.name;
      if (k === "transparencyRange" || k === "transparency") {
        if (el.value === "" || !Number.isFinite(Number(el.value))) return;
        draft.transparency = Math.max(0, Math.min(100, Number(el.value)));
        draft.transparencyMode = "custom";
      } else if (k === "priceLabels") draft.priceLabels = el.checked;
      else if (k in draft) draft[k] = el.value;
      reflect();
    });
    const confirm = (event) => {
      event.preventDefault();
      if (dialogEpoch !== coordinator.epoch()) {
        close();
        return;
      }
      if (!form.reportValidity()) return;
      mapping.configure(draft);
      close();
    };
    form.addEventListener("submit", confirm);
    dialog
      .querySelector('[data-action="confirm"]')
      .addEventListener("click", confirm);
    for (const action of ["close", "cancel"])
      dialog
        .querySelector(`[data-action="${action}"]`)
        .addEventListener("click", close);
    dialog
      .querySelector('[data-action="defaults"]')
      .addEventListener("click", () => {
        draft = { ...mapping.defaults(), enabled: draft.enabled };
        reflect();
      });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    doc.body.appendChild(dialog);
    reflect();
    dialog.showModal();
    field("style").focus();
  }
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
      entry.querySelector('[role="cell"]')?.remove();
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
      button.className = "mw-sync-settings-entry";
      button.textContent = "同步设置…";
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
    if (dialog && dialogEpoch !== coordinator.epoch()) close();
    const state = coordinator.snapshot(),
      config = mapping.snapshot();
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
      doc.removeEventListener("click", selectNativeSync, true);
      doc.removeEventListener("keydown", selectNativeSync, true);
    },
  };
}
