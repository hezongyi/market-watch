/* THROWAWAY: three toolbar entry designs in the real chart, no business wiring.
 * One system-message SVG, three structures; only static preview counts.
 */
(() => {
  globalThis.mw75EntryPreview?.dispose();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4M12 2V1"/></svg>';
  const buttons = [...document.querySelectorAll('button')].filter(e=>/^系统消息 · \d+$/.test(e.textContent.trim()));
  const originals = buttons.map(button=>({button,html:button.innerHTML,style:button.getAttribute('style'),label:button.getAttribute('aria-label')}));
  const style = document.createElement('style');
  style.textContent = `
    .mw75-entry {box-sizing:border-box!important;position:relative!important;height:38px!important;min-height:38px!important;flex:none!important;padding:0 8px!important;overflow:visible!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;color:#dbdbdb!important}
    .mw75-entry[data-variant=A] {width:52px!important;min-width:52px!important;max-width:52px!important}
    .mw75-entry[data-variant=B] {width:76px!important;min-width:76px!important;max-width:76px!important}
    .mw75-entry[data-variant=C] {width:132px!important;min-width:132px!important;max-width:132px!important}
    .mw75-entry .entry-content {display:inline-flex;align-items:center;justify-content:center;gap:8px;position:relative;white-space:nowrap;font:13px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .mw75-entry .entry-icon {display:flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none}
    .mw75-entry svg {width:22px;height:22px;display:block}
    .mw75-entry .entry-count {font:600 11px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;box-sizing:border-box;padding:0 4px;border-radius:9px;background:#f23645;color:#fff;font-variant-numeric:tabular-nums}
    .mw75-entry[data-variant=A] .entry-count {position:absolute;top:-5px;right:-10px;border:2px solid #0f0f0f;min-width:19px;height:19px;padding:0 3px;font-size:10px;line-height:15px}
    .mw75-entry[data-variant=B] .entry-count {min-width:26px}
    .mw75-entry[data-variant=C] .entry-content {gap:6px}
    .mw75-entry .entry-count.is-zero {visibility:hidden}
    .mw75-entry[data-variant=A] .entry-count.is-zero {display:none}
    .mw75-entry .entry-count-slot {width:28px;display:flex;align-items:center;justify-content:center}
  `;
  document.head.append(style);
  function render(variant='A',count=23) {
    const text=count>99?'99+':String(count);
    const badge=`<span class="entry-count ${count===0?'is-zero':''}" aria-hidden="true">${text}</span>`;
    for (const b of buttons) {
      b.classList.add('mw75-entry');b.dataset.variant=variant;
      b.setAttribute('aria-label',`系统消息，${count} 条未读；样式预览`);
      b.setAttribute('data-tooltip',`系统消息，${count} 条未读；样式预览`);
      b.innerHTML=`<span class="entry-content"><span class="entry-icon" aria-hidden="true">${svg}</span>${variant==='C'?'<span>系统消息</span>':''}${variant==='A'?badge:`<span class="entry-count-slot">${badge}</span>`}</span>`;
    }
  }
  const prevent = event => {if(event.target.closest('.mw75-entry')){event.preventDefault();event.stopImmediatePropagation();}};
  document.addEventListener('click',prevent,true);
  globalThis.mw75EntryPreview={
    render,
    dispose(){document.removeEventListener('click',prevent,true);for(const {button,html,style,label}of originals){button.innerHTML=html;button.classList.remove('mw75-entry');delete button.dataset.variant;if(style===null)button.removeAttribute('style');else button.setAttribute('style',style);button.setAttribute('aria-label',label);}style.remove();},
  };
  render(new URLSearchParams(location.search).get('variant')||'A');
})();
