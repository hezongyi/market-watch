/* Pure paginated selection, explicit open owns the chart's subsequent demand. */
globalThis.MWSeriesPicker = (() => {
  function attach(widget, search, openCenter) {
    const button=widget.createButton();button.textContent='行情搜索';button.title='分页选择平台、自建或组合行情';
    button.addEventListener('click',()=>{
      const chart=widget.activeChart(),current=MWSeries.decode(chart.symbol());
      const dialog=document.createElement('dialog');dialog.className='mw-series-picker';
      if(widget.getTheme?.().toLowerCase()==='light')dialog.dataset.theme='light';
      dialog.setAttribute('aria-labelledby','mw-series-title');
      dialog.innerHTML=`<div class="mw-series-heading"><h2 id="mw-series-title">选择行情</h2><button type="button" class="mw-series-close" aria-label="关闭行情搜索">关闭</button></div>
        <div class="mw-series-filters">
          <label>行情类型<select name="kind"><option value="provider">平台原生</option><option value="history">自建历史</option><option value="composite">组合行情</option></select></label>
          <label>查找品种<input type="search" name="query" maxlength="100" placeholder="品种或准确来源代码"></label>
          <label>历史来源<select name="source"><option value="">全部来源</option><option value="dukascopy">Dukascopy</option><option value="oanda">OANDA</option><option value="binance">Binance</option><option value="yahoo">Yahoo</option></select></label>
          <label>聚合日界<select name="calendar"><option value="">全部日界</option><option value="ny17">NY17</option><option value="utc0">UTC 00:00</option></select></label>
        </div><p role="status"></p><p role="alert" hidden></p><div class="mw-series-results"></div>
        <nav aria-label="行情搜索分页"><button type="button" data-action="previous">上一页行情</button><span></span><button type="button" data-action="next">下一页行情</button></nav>
        <p>平台返回原生周期；自建固定发布版本；组合在打开后准备实时接续。</p>
        <p>未就绪行情：请从图表顶部的数据中心维护或配置映射。</p>`;
      document.body.append(dialog);
      const kind=dialog.querySelector('[name=kind]'),query=dialog.querySelector('[name=query]'),source=dialog.querySelector('[name=source]'),calendar=dialog.querySelector('[name=calendar]');
      kind.value=current.series_kind==='managed'?'provider':current.series_kind;
      const status=dialog.querySelector('[role=status]'),alert=dialog.querySelector('[role=alert]'),results=dialog.querySelector('.mw-series-results');
      const previous=dialog.querySelector('[data-action=previous]'),next=dialog.querySelector('[data-action=next]');
      let offsets=[0],nextOffset=null,generation=0,timer,closed=false;
      const labels={provider:'平台原生',history:'自建历史',composite:'组合行情'};
      async function load() {
        const own=++generation;
        status.textContent='正在查找…';alert.hidden=true;previous.disabled=next.disabled=true;
        for(const item of results.querySelectorAll('button'))item.disabled=true;
        calendar.disabled=kind.value==='provider';
        source.querySelector('[value=yahoo]').disabled=kind.value!=='provider';
        if(kind.value!=='provider'&&source.value==='yahoo')source.value='';
        try{
          const page=await search({kind:kind.value,query:query.value,source:source.value,
            calendar:kind.value==='provider'?'':calendar.value,offset:offsets.at(-1)});
          if(closed||own!==generation)return;
          results.replaceChildren();nextOffset=page.next_offset;
          for(const row of page.items){
            const item=document.createElement('button');item.type='button';item.className='mw-series-result';
            const title=document.createElement('strong');title.textContent=row.symbol;
            const detail=document.createElement('span');detail.textContent=row.description;
            item.append(title,detail);item.setAttribute('aria-label',row.symbol+' · '+row.description);
            item.addEventListener('click',async()=>{
              item.disabled=true;
              dialog.close();
              try{await chart.setSymbol(row.ticker,{doNotActivateChart:true})}
              catch(e){openCenter(e)}
            });results.append(item);
          }
          status.textContent=page.items.length?`本页 ${page.items.length} 条${labels[kind.value]}`:'没有符合条件的可用行情。';
          previous.disabled=offsets.length===1;next.disabled=nextOffset===null;
          dialog.querySelector('nav span').textContent=`第 ${offsets.length} 页`;
        }catch(e){if(!closed&&own===generation){status.textContent='查找失败，已有结果保留。';alert.hidden=false;alert.textContent=String(e);
          const retry=document.createElement('button');retry.type='button';retry.textContent='重试搜索';retry.onclick=load;alert.append(retry)}}
      }
      function reset(){offsets=[0];clearTimeout(timer);++generation;previous.disabled=next.disabled=true;
        status.textContent='正在查找…';for(const item of results.querySelectorAll('button'))item.disabled=true;timer=setTimeout(load,250)}
      query.addEventListener('input',reset);for(const input of [kind,source,calendar])input.addEventListener('change',reset);
      previous.onclick=()=>{offsets.pop();load()};next.onclick=()=>{offsets.push(nextOffset);load()};
      // The host iframe deliberately disallows form submission, including method=dialog.
      dialog.querySelector('.mw-series-close').onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>{closed=true;++generation;clearTimeout(timer);dialog.remove();button.focus()},{once:true});
      dialog.showModal();query.focus();load();
    });
    return button;
  }
  return {attach};
})();
