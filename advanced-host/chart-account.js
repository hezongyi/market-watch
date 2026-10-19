/* Native notice shell and native input/button classes; only fields are host-owned.
   Credentials are submitted through the trusted parent, never to a data provider. */
function chartPasswordDialog(widget, doc, submit, report) {
  if (doc.querySelector('[data-name="mw-password-dialog"]')) return;
  let active = true;
  const observer = new MutationObserver(mount);
  widget.showNoticeDialog({title: "修改密码", body: " ", callback: () => {
    active = false; observer.disconnect();
  }});
  observer.observe(doc.body, {childList: true, subtree: true});
  mount();
  function mount() {
    if (!active) return;
    const shell = [...doc.querySelectorAll('[data-name="warning-dialog"]')]
      .find(node => node.querySelector('[class*="title-"]')?.textContent === "修改密码");
    if (!shell || shell.dataset.mwPassword) return;
    observer.disconnect();
    shell.dataset.mwPassword = "true";
    shell.dataset.name = "mw-password-dialog";
    shell.setAttribute("role", "dialog");
    shell.setAttribute("aria-modal", "true");
    shell.setAttribute("aria-label", "修改密码");
    const content = shell.querySelector('[class*="content-"]');
    const footer = shell.querySelector('[class*="footer-"]');
    const nativeButton = footer.querySelector('button');
    const closeButton = shell.querySelector('[data-name="close"]');
    const form = doc.createElement("form");
    form.className = "mw-password-form";
    const inputs = [];
    for (const [title, autocomplete] of [["当前密码", "current-password"], ["新密码", "new-password"], ["确认新密码", "new-password"]]) {
      const label = doc.createElement("label");
      label.textContent = title;
      const wrapper = doc.createElement("span");
      wrapper.className = "container-WDZ0PRNh container-small-WDZ0PRNh intent-default-WDZ0PRNh border-thin-WDZ0PRNh size-small-WDZ0PRNh stretch-WDZ0PRNh adjust-position-WDZ0PRNh first-row-WDZ0PRNh first-col-WDZ0PRNh";
      wrapper.innerHTML = '<span class="inner-slot-W53jtLjw inner-middle-slot-W53jtLjw"><input class="input-RUSovanF size-small-RUSovanF" type="password" required></span><span class="highlight-WDZ0PRNh size-small-WDZ0PRNh"></span>';
      const input = wrapper.querySelector("input");
      input.autocomplete = autocomplete;
      input.addEventListener("focus", () => {
        wrapper.classList.remove("intent-default-WDZ0PRNh");
        wrapper.classList.add("intent-primary-WDZ0PRNh", "focused-WDZ0PRNh", "with-highlight-WDZ0PRNh");
      });
      input.addEventListener("blur", () => {
        wrapper.classList.remove("intent-primary-WDZ0PRNh", "focused-WDZ0PRNh", "with-highlight-WDZ0PRNh");
        wrapper.classList.add("intent-default-WDZ0PRNh");
      });
      inputs.push(input);
      label.appendChild(wrapper);
      form.appendChild(label);
    }
    const hint = doc.createElement("small");
    hint.textContent = "新密码为 6–512 个字符，支持中文、表情、符号和空格";
    const error = doc.createElement("p");
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(hint, error);
    content.replaceChildren(form);
    const button = (text, type) => {
      const node = nativeButton.cloneNode(true);
      node.type = type;
      node.removeAttribute("name");
      node.removeAttribute("data-qa-id");
      node.removeAttribute("data-overflow-tooltip-text");
      node.querySelector('[class*="content-"]').textContent = text;
      return node;
    };
    const save = button("保存", "button");
    const cancel = button("取消", "button");
    // Native popup event handling prevents browser default form submission.
    // Explicitly submit the host form while retaining the native button skin.
    save.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      submitPassword();
    });
    cancel.classList.remove("primary-D4RPB3ZC");
    cancel.addEventListener("click", () => closeButton.click());
    footer.replaceChildren(save, cancel);
    form.appendChild(footer);
    let busy = false;
    const showError = text => {error.textContent = text; error.hidden = false;};
    const center = () => {
      const outer = shell.parentElement;
      outer.style.transform = `translate(${Math.max(8, (doc.defaultView.innerWidth - outer.offsetWidth) / 2)}px, ${Math.max(8, (doc.defaultView.innerHeight - outer.offsetHeight) / 2)}px)`;
    };
    // The isolated vendor iframe forbids HTML form navigation/submission.
    // Validate fields and invoke the parent RPC directly from the button.
    async function submitPassword() {
      if (busy || !form.reportValidity()) return;
      const [current, password, confirmation] = inputs;
      if ([...current.value].length > 512) {showError("当前密码最多 512 个字符");center();return;}
      const length = [...password.value].length;
      if (length < 6 || length > 512) {showError("新密码须为 6–512 个字符");center();return;}
      if (password.value !== confirmation.value) {showError("两次输入的新密码不一致");center();return;}
      busy = true;
      error.hidden = true;
      for (const node of [...inputs, save, cancel, closeButton]) node.disabled = true;
      try {
        await submit({current_password: current.value, new_password: password.value});
        for (const input of inputs) input.value = "";
        closeButton.disabled = false;
        closeButton.click();
        // The parent records success in the system center; no second notice dialog.
      } catch (failure) {showError(String(failure).replace(/^Error:\s*/, ""));center();}
      finally {
        busy = false;
        for (const node of [...inputs, save, cancel, closeButton]) node.disabled = false;
      }
    }
    // Native Enter/Escape handlers must not dismiss an unfinished account form.
    shell.addEventListener("keydown", event => {
      if (event.key === "Enter") {event.preventDefault();event.stopPropagation();if (!busy) submitPassword();}
      else if (event.key === "Escape" && busy) {event.preventDefault();event.stopPropagation();}
    }, true);
    doc.defaultView.requestAnimationFrame(() => {center();inputs[0].focus();});
  }
}
