/* Prototype refinements layered over the actual frozen source. No app/runtime imports. */
const previewParams = new URLSearchParams(location.search);
document.body.classList.toggle('embedded', previewParams.get('embed') === '1');
state.noticeDismissed = true;
state.theme = previewParams.get('theme') === 'light' ? 'light' : 'dark';
state.scene = previewParams.get('scene') || 'normal';
state.previewTime = previewParams.get('time') || 'morning';

quoteRow = function(i) {
  return `<button class="quote-row spark-fixed ${quoteMuted(i)?'quote-cached':''}" data-action="chart" data-id="${i.id}" aria-label="查看${i.name}图表"><span class="quote-info"><strong>${i.symbol}</strong><small>${i.name}</small><span class="quote-origin">${i.kind} · ${i.source}</span></span>${spark(i)}<span class="quote-price"><strong>${num(i.price,i.dec)}</strong><span class="${quoteMuted(i)?'muted':tint(i)}">${i.pct}</span></span></button>`;
};
const frozenWatchPage = watchPage;
watchPage = () => frozenWatchPage() + (state.watch.length ? '<p class="watch-foot">固定日界线 · 未到的时间留白</p>' : '');

dataList = function() {
  const rows = dataRows();
  return rows.map(i => `<button class="data-card" data-action="data-detail" data-id="${i.id}" data-kind="${state.centerTab}"><span class="data-heading"><span class="data-identity"><strong>${i.symbol}</strong><span class="data-name">${i.name}</span></span><span class="badge">${state.centerTab}</span></span><p>${i.source} · ${state.centerTab==='自建'?'M1 基础数据，每日维护':state.centerTab==='组合'?'历史 + 实时，固定组合修订':'供应商原生行情'}</p><span class="data-foot"><span>${cached()?'上次读取 · 待更新':state.centerTab==='平台'?'目录可查询':'数据至 09:41 · 模拟'}</span><span class="data-link">${supported(i).length} 个周期${icon('chevron')}</span></span></button>`).join('') || empty('没有匹配的数据','尝试修改关键词或切换来源筛选。',action('clear-center','清除筛选','','soft-btn'));
};
const frozenCenterPage = centerPage;
centerPage = () => frozenCenterPage().replace(/(class="group-picker"[^>]*>)(全部来源|OANDA|Binance|FXCM|Dukascopy|Yahoo|AKShare)(<\/button>)/, '$1$2'+icon('down')+'$3');
const frozenAlertCard = alertCard;
alertCard = r => frozenAlertCard(r).replace(`<div class="alert-condition">${r.relation} ${num(r.threshold,getInstrument(r.instrument).dec)}</div>`, `<div class="alert-condition"><span>${r.relation}</span><b>${num(r.threshold,getInstrument(r.instrument).dec)}</b></div>`);
const frozenChartPage = chartPage;
chartPage = () => {
  const i = current();
  return frozenChartPage().replace('<div class="chart-legend">', `<div class="chart-price"><b>${num(i.price,i.dec)}</b><span class="${quoteMuted(i)?'muted':tint(i)}">${i.pct}</span></div><div class="chart-legend">`) + '<p class="chart-disclaimer">模拟 K 线 · 正式版使用专业图表</p>';
};
// The illustrated chart gets less height after the compact quote is introduced.
const frozenCandles = candles;
candles = () => frozenCandles().replace(/font-size:9px/g, 'font-size:13px');

const frozenEmpty = empty;
empty = (title, description, button='') => frozenEmpty(title,description,button).replace(icon('watch'),icon(state.scene==='offline-empty'?'wifi':state.page==='alerts'?'bell':state.page==='center'?'data':state.page==='chart'?'chart':'watch'));
const frozenSceneContent = sceneContent;
sceneContent = content => state.scene==='empty' && state.page==='chart'
  ? empty('当前周期暂无 K 线','可切换周期，或稍后重新读取。',action('pick-frame','切换周期','','soft-btn'))
  : frozenSceneContent(content);

// Consistent in-app choices; the original select retains its value for A06 forms.
function decorateSelects() {
  document.querySelectorAll('#sheet select').forEach(select => {
    if(!select.id) return;
    select.hidden = true;
    let button = select.nextElementSibling;
    if(!button?.classList.contains('select-control')) {
      button = document.createElement('button');
      button.type = 'button'; button.className = 'select-control';
      button.dataset.action = 'field-picker'; button.dataset.id = select.id;
      select.after(button);
    }
    const label = select.closest('.field')?.querySelector('span')?.textContent || '选择';
    button.setAttribute('aria-label', `${label}：${select.selectedOptions[0]?.textContent || ''}`);
    button.setAttribute('aria-haspopup','dialog');
    button.innerHTML = `<span>${esc(select.selectedOptions[0]?.textContent || '')}</span>${icon('down')}`;
  });
}
const frozenOpenSheet = openSheet;
openSheet = function(...args) {
  frozenOpenSheet(...args); decorateSelects();
  // Announce the heading on entry; keyboard Tab still reaches every control.
  const heading = $('#sheet-title'); heading.tabIndex = -1; heading.focus({preventScroll:true});
};
const frozenRestoreSheet = restoreSheet;
restoreSheet = function(...args) { frozenRestoreSheet(...args); decorateSelects(); };
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if(!b || b.disabled) return;
  if(b.dataset.action==='field-picker') {
    const select = document.getElementById(b.dataset.id);
    const title = select.closest('.field')?.querySelector('span')?.textContent || '选择';
    const options = [...select.options].map(option => `<button type="button" class="picker-option" data-action="field-option" data-field="${esc(select.id)}" data-value="${esc(option.value)}" aria-pressed="${option.selected}"><span>${esc(option.textContent)}</span>${option.selected?icon('check'):''}</button>`).join('');
    openSheet(title,`<div class="picker-options">${options}</div>`,'field-picker');
    $('#sheet [aria-pressed=true]')?.focus();
  }
  if(b.dataset.action==='field-option') {
    const {field,value} = b.dataset;
    restoreSheet();
    const select = document.getElementById(field);
    select.value = value;
    select.dispatchEvent(new Event('change',{bubbles:true}));
    decorateSelects(); select.nextElementSibling.focus();
  }
});

const frozenRender = render;
const frozenPaintAlertNotice = paintAlertNotice;
paintAlertNotice = function() {
  frozenPaintAlertNotice();
  const notice = $('#alert-notice');
  $('#screen').style.paddingTop = !notice.hidden ? (notice.offsetHeight+12)+'px' : '';
};
render = function() {
  frozenRender();
  document.querySelector('.context-status')?.remove();
  const status = {
    offline:'手机离线 · 当前显示上次数据',loading:'正在连接 · 当前显示上次数据',
    error:'刷新失败 · 已保留上次数据',stale:'部分行情已陈旧 · 请留意更新时间'
  }[state.scene];
  if(status && !['login','more'].includes(state.page)) {
    const note = document.createElement('div'); note.className = 'context-status';
    note.setAttribute('role','status'); note.innerHTML = icon('wifi')+`<span>${status}</span>`;
    $('#header').after(note);
  }
  if(state.page==='watch' && state.scene==='offline-empty')$('.sse-status small').textContent='尚无通信记录';
  if(state.page==='watch' && state.scene==='error')$('.sse-status small').textContent='上次通信 '+demoClock(75*60000);
  decorateSelects();
};

// Keep finance-calendar examples, omit unrelated reference-brand artwork in this iteration.
sparkOptions = () => openSheet('分时图窗口',hint('外汇与黄金采用 NY17，其他品种采用 UTC0。缺失数据断开，未来时间留白。')+`<div class="spark-choices">${[['morning','上午 · 北京时间 09:41'],['europe','欧盘 · 北京时间 17:41'],['america','美盘 · 北京时间 22:41']].map(([id,title])=>`<button type="button" data-action="preview-time" data-id="${id}" aria-pressed="${state.previewTime===id}" class="source-tile">${title}</button>`).join('')}</div>`+hint('仅用于设计审阅，示例日期为 2026-11-11；不是真实行情。横线为参考价，圆点为最新有效样本；两条竖线分别对应伦敦、纽约 08:00。')+action('demo-notice','演示告警浮动通知','','soft-btn full'),'spark-options');

const previewSheets = {
  create:()=>{state.selected='gold';formCreate()},edit:()=>formCreate(1),search:()=>searchSheet(),
  groups:()=>groups(),manage:()=>manage(),detail:()=>dataDetail('gold'),rule:()=>ruleDetail(1),
  events:()=>events(),issue:()=>issue(),sources:()=>sourcesSheet(),indicators:()=>indicators(),
  theme:()=>theme(),connection:()=>connection(),capability:()=>{state.selected='btc';formCreate()},
  saved:()=>{openSheet('规则已保存','<div class="result-icon">'+icon('check')+'</div><p class="result-copy"><strong>等待服务器接管</strong>黄金价格提醒已保存。<br>确认接管后才会显示“监控中”。</p>'+hint('这是设计演示，没有真正提交规则。')+action('close-sheet','查看告警列表','','primary full'),'saved')},
  storage:()=>operation('设置未能记住','本次仍可使用，重新打开后可能无法保留。'),
  notification:()=>{state.noticeDismissed=false;paintAlertNotice()},
  discard:()=>{state.selected='gold';formCreate();state.dirty=true;askClose()},
  conflict:async()=>{state.scene='conflict';state.selected='gold';formCreate();$('#rule-form').requestSubmit()},
  failure:async()=>{state.scene='save-error';state.selected='gold';formCreate();$('#rule-form').requestSubmit()}
};
$('#review-tools').onclick=()=>{
  document.body.classList.toggle('review-open');
  $('#review-tools').setAttribute('aria-expanded',String(document.body.classList.contains('review-open')));
  positionSheet();
};
$('#review-sheet').onchange=e=>{closeAll();previewSheets[e.target.value]?.();e.target.value=''};
$('#reset').onclick=async()=>{if(await clearChartLayout()){const u=new URL(location.href);u.searchParams.delete('sheet');u.searchParams.delete('scene');u.searchParams.set('page','watch');location.href=u.href}};
(async()=>{
  await restoreChartLayout();
  if(state.scene==='expired'){routeBeforeLogin=state.page;state.page='login'}
  if(previewParams.get('scale')==='150')document.documentElement.style.fontSize='21px';
  render();
  previewSheets[previewParams.get('sheet')]?.();
})();
