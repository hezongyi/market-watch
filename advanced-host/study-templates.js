/* Public chart template APIs and the existing preferences adapter. */
function chartStudyTemplates(widget, templates, readonly, report) {
  const probe=widget.createButton({align:'left',useTradingViewStyle:false});
  const doc=probe.ownerDocument;
  widget.removeButton(probe);
  let menu, disposed=false, confirming=false, previousFocus;
  const dialog=doc.createElement('dialog');
  dialog.className='mw-study-template-save';
  dialog.setAttribute('aria-labelledby','mw-study-template-title');
  dialog.innerHTML=`<form><h2 id="mw-study-template-title">保存指标模板</h2>
    <label>模板名称<input name="name" maxlength="64" required autocomplete="off"></label>
    <p role="alert"></p><footer><button type="button" data-cancel>取消</button>
    <button type="submit">保存</button></footer></form>`;
  const style=doc.createElement('style');
  style.textContent=`.mw-study-template-save{width:min(360px,calc(100vw - 48px));box-sizing:border-box;border:1px solid #434651;border-radius:8px;padding:20px;font:14px/1.5 system-ui;background:#fff;color:#20242e}
    .mw-study-template-save[data-theme=dark]{background:#1e222d;color:#e0e3eb}
    .mw-study-template-save::backdrop{background:rgba(0,0,0,.5)}
    .mw-study-template-save h2{font-size:18px;margin:0 0 16px}
    .mw-study-template-save label{display:grid;gap:8px}.mw-study-template-save input{box-sizing:border-box;width:100%;min-height:40px;padding:8px;border:1px solid #787b86;border-radius:4px;background:inherit;color:inherit;font:inherit}
    .mw-study-template-save footer{display:flex;justify-content:flex-end;gap:8px}
    .mw-study-template-save button{min-height:40px;padding:8px 16px;border:1px solid #787b86;border-radius:4px;font:inherit;cursor:pointer}
    .mw-study-template-save button[type=submit]{background:#2962ff;color:white;border-color:#2962ff}
    .mw-study-template-save :focus-visible{outline:2px solid #42a5f5;outline-offset:2px}
    .mw-study-template-save [role=alert]{color:#f23645;min-height:20px;margin:8px 0}`;
  doc.head.append(style);doc.body.append(dialog);
  const input=dialog.querySelector('input'), status=dialog.querySelector('[role=alert]');
  const submit=dialog.querySelector('[type=submit]');
  const confirm=(title,body)=>new Promise(resolve=>widget.showConfirmDialog({title,body,callback:resolve}));
  const restoreFocus=()=>{if(!disposed && !confirming) previousFocus?.focus();};
  function close() {dialog.close();restoreFocus();}
  dialog.querySelector('[data-cancel]').onclick=close;
  dialog.addEventListener('close',restoreFocus);
  async function refresh() {
    const rows=await templates.getAllStudyTemplates();
    if(disposed) return;
    const items=readonly?[]:[{title:'保存指标模板',onSelect:()=>{
      previousFocus=doc.activeElement;input.value='';status.textContent='';
      dialog.dataset.theme=widget.getTheme().toLowerCase();dialog.showModal();input.focus();
    }}];
    for(const row of rows.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))) {
      items.push({title:row.name,onSelect:async()=>{
        try {
          const content=await templates.getStudyTemplateContent(row);
          if(!disposed) widget.activeChart().applyStudyTemplate(typeof content==='string'?JSON.parse(content):content);
        } catch(error) {report(error);}
      }});
      if(!readonly) items.push({title:'删除 '+row.name,onSelect:async()=>{
        try {
          if(await confirm('删除指标模板',`删除“${row.name}”？当前图表保留。`) && !disposed) {
            await templates.removeStudyTemplate(row);await refresh();
          }
        } catch(error) {report(error);}
      }});
    }
    if(!items.length) items.push({title:'暂无指标模板',onSelect:()=>{}});
    if(menu) menu.applyOptions({items});
    else {
      const created=await widget.createDropdown({title:'指标模板',tooltip:'保存或应用指标模板',items});
      if(disposed) created.remove();else menu=created;
    }
  }
  dialog.querySelector('form').onsubmit=async event=>{
    event.preventDefault();
    const name=input.value.trim();
    if(readonly || disposed || !name || submit.disabled) return;
    submit.disabled=true;status.textContent='';
    try {
      const rows=await templates.getAllStudyTemplates();
      if(disposed) return;
      if(rows.some(row=>row.name===name)) {
        // HTML modal dialogs make the library's separate confirm dialog inert.
        // Release the top layer while confirming; cancellation restores the form.
        confirming=true;dialog.close();
        let approved;
        try {approved=await confirm('覆盖指标模板',`覆盖“${name}”？`);}
        finally {confirming=false;}
        if(disposed) return;
        if(!approved) {dialog.showModal();input.focus();return;}
      }
      const content=JSON.stringify(widget.activeChart().createStudyTemplate({saveSymbol:false,saveInterval:false}));
      await templates.saveStudyTemplate({name,content});
      if(!disposed) {await refresh();close();}
    } catch(error) {
      if(!disposed) {
        if(!dialog.open) dialog.showModal();
        status.textContent=String(error);report(error);
      }
    }
    finally {submit.disabled=false;}
  };
  void refresh().catch(report);
  return {dispose() {disposed=true;menu?.remove();dialog.remove();style.remove();}};
}
