/* Ordinary chart faults never take focus. Draft recovery stays in native UI. */
function chartNoticeStore({now = () => Date.now(), windowMs = 30000} = {}) {
  const records = new Map();
  let live = new Set();
  const keyOf = text => text.replace(/^(?:Error:\s*)+/, '').trim();
  return {
    update(notices) {
      const next = new Set(), stamp = now();
      for (const notice of notices) {
        if (notice.recover) continue;
        const key = keyOf(notice.text), source = JSON.stringify([notice.id, key]);
        next.add(source);
        if (live.has(source)) continue;
        let record = records.get(key);
        if (!record || stamp - record.last > windowMs) {
          record = {key, text:key, count:0, dismissed:false, first:stamp};
          records.set(key, record);
        }
        record.count++; record.last = stamp;
      }
      live = next;
      for (const [key, record] of records)
        if (stamp - record.last > windowMs) records.delete(key);
      // A bounded journal also bounds a burst of distinct failures.
      while (records.size > 100) records.delete(records.keys().next().value);
      return this.visible();
    },
    dismiss(key) {const record = records.get(key); if (record) record.dismissed = true;},
    visible() {return [...records.values()].filter(r => !r.dismissed).slice(-3);},
  };
}

function chartNotices(document) {
  const store = chartNoticeStore(), cards = new Map();
  const region = document.createElement('div');
  region.className = 'mw-chart-notices';
  region.setAttribute('aria-label', '图表提示');
  const style = document.createElement('style');
  style.textContent = `
    .mw-chart-notices {position:fixed;right:72px;bottom:16px;z-index:8;display:flex;flex-direction:column;gap:8px;width:min(320px,calc(100vw - 32px));pointer-events:none}
    .mw-chart-notice {display:flex;align-items:flex-start;gap:8px;padding:12px;border:1px solid #787b86;border-radius:6px;background:var(--mw-notice-background,#171a20);color:var(--mw-notice-text,#e0e3eb);box-shadow:0 2px 8px #0004;font:13px/1.5 system-ui;pointer-events:auto;overflow-wrap:anywhere}
    .mw-chart-notice-message {flex:1;min-width:0}
    .mw-chart-notice button {flex-shrink:0;min-width:28px;min-height:28px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font:inherit}
    .mw-chart-notice button:focus-visible {outline:2px solid #42a5f5;outline-offset:2px}
    @media(max-width:600px) {.mw-chart-notices {right:16px;bottom:12px}}
  `;
  document.head.append(style); document.body.append(region);
  function remove(key) {
    const card = cards.get(key);
    if (card) {clearTimeout(card.timer); card.element.remove(); cards.delete(key);}
  }
  return {
    theme(value){
      const dark=String(value).toLowerCase()!=='light';
      region.style.setProperty('--mw-notice-background',dark?'#171a20':'#fff');
      region.style.setProperty('--mw-notice-text',dark?'#e0e3eb':'#20242e');
    },
    update(notices) {
      const rows = store.update(notices), keys = new Set(rows.map(r => r.key));
      for (const key of cards.keys()) if (!keys.has(key)) remove(key);
      for (const row of rows) {
        let card = cards.get(row.key);
        if (!card) {
          const element = document.createElement('div'), message = document.createElement('span');
          element.className = 'mw-chart-notice';
          message.className = 'mw-chart-notice-message';
          message.setAttribute('role', 'status'); message.setAttribute('aria-atomic', 'true');
          const close = document.createElement('button');
          close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图表提示');
          close.onclick = () => {store.dismiss(row.key); remove(row.key);};
          element.append(message, close); region.append(element);
          card = {element, message, timer:null}; cards.set(row.key, card);
          const pause=()=>clearTimeout(card.timer);
          const resume=()=>{pause();card.timer=setTimeout(()=>{store.dismiss(row.key);remove(row.key);},8000);};
          element.addEventListener('mouseenter',pause);element.addEventListener('mouseleave',resume);
          element.addEventListener('focusin',pause);element.addEventListener('focusout',resume);resume();
        }
        const text = row.text + (row.count > 1 ? `（${row.count} 次）` : '');
        if (card.message.textContent !== text) card.message.textContent = text;
      }
    },
    dispose() {for (const key of cards.keys()) remove(key); region.remove(); style.remove();},
  };
}
