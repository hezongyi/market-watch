/* THROWAWAY visual preview: one user-selected native notice design, two categories.
 * Inject only into a task-owned, isolated Playwriter chart frame. No API writes.
 * Reuses actual v31.1.0 Dialog, NavButton and Button plus SimpleDialog CSS.
 * Does not use PopupDialog/SimpleDialog: their portal/focus behavior is modal.
 */
(() => {
  const req = globalThis.noticePreviewVendor;
  const React = req(779474), h = React.createElement;
  const { Dialog } = req(491617);
  const { NavButton } = req(569716);
  const { Button } = req(536605);
  const css = req(412377);
  const closeIcon = req(176268);
  globalThis.nativeInstantPreview?.dispose();
  const host = document.createElement('div');
  host.dataset.name = 'mw75-native-instant-preview-root';
  document.body.append(host);
  const nativeStyle = document.createElement('link');
  nativeStyle.rel = 'stylesheet';
  nativeStyle.href = '/charting_library_91bf3b2668480f58/bundles/2371.3fc94a1aa7a1e03d91e4.css';
  document.head.append(nativeStyle);
  const style = document.createElement('style');
  style.textContent = `
    .mw75-native-instant-preview {
      position:fixed!important;left:50%!important;top:var(--mw75-preview-top,46px)!important;
      transform:translateX(-50%);width:var(--mw75-preview-width,355px)!important;min-width:0!important;
      max-width:calc(100vw - 24px)!important;margin:0!important;z-index:151!important;
    }
    .mw75-native-instant-preview .${css.main} {margin:0!important;padding:24px!important;min-width:0}
    .mw75-native-instant-preview .${css.close} {position:absolute;top:8px;right:8px;margin:0!important}
    .mw75-native-instant-preview .${css.title} {
      display:flex;align-items:center;gap:10px;padding-right:24px;
      font-size:18px!important;line-height:26px!important;margin-bottom:14px!important;
    }
    .mw75-native-instant-preview .${css.content} {
      margin:0!important;padding:0!important;font-size:14px!important;line-height:22px!important;
    }
    .mw75-native-instant-preview p {margin:0}
    .mw75-native-instant-preview .mw75-summary {font-weight:600;margin-bottom:4px}
    .mw75-native-instant-preview .${css.footer} {
      display:flex;flex-direction:row!important;align-items:center;gap:12px;margin-top:22px!important;
    }
    .mw75-native-instant-preview .mw75-time {
      margin-right:auto;font-size:12px;opacity:.78;font-variant-numeric:tabular-nums;
    }
    .mw75-native-instant-preview .mw75-detail {
      color:inherit;border:0;background:none;font:inherit;font-size:13px;cursor:pointer;padding:5px 0;
    }
    .mw75-native-instant-preview .mw75-icon {display:inline-flex;width:22px;height:22px;flex:none}
    .mw75-native-instant-preview .mw75-icon svg {width:22px;height:22px}
    .mw75-native-instant-preview :focus-visible {outline:2px solid #2962ff;outline-offset:3px}
  `;
  document.head.append(style);
  function position() {
    const width = window.innerWidth;
    const panel = document.querySelector('.widgetbar-pagescontent')?.getBoundingClientRect();
    const clear = panel?.width > 60 && panel.left > width / 2
      ? 2 * (panel.left - width / 2 - 8) : width - 24;
    host.style.setProperty('--mw75-preview-width', Math.min(355, width - 24, clear) + 'px');
    const toolbar = document.querySelector('.innerWrap-OhqNVIYA')?.getBoundingClientRect();
    host.style.setProperty('--mw75-preview-top', ((toolbar?.bottom || 38) + 8) + 'px');
  }
  position();
  window.addEventListener('resize', position);
  const icons = {
    system: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4M12 2V1"/></svg>',
    trade: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v17h17M7 14l4-4 4 2 5-7M16 5h4v4"/></svg>',
  };
  let root;
  function render(kind = 'system') {
    const system = kind === 'system';
    const close = () => root.render(null);
    const title = h('span', null, system ? '系统消息' : '交易告警');
    const icon = h('span', {className:'mw75-icon', 'aria-hidden':true,
      dangerouslySetInnerHTML:{__html:icons[kind]}});
    const tree = h(Dialog, {
      className: `${css.popupDialog} mw75-native-instant-preview`,
      containerTabIndex:-1, containerAriaLabel:'即时通知预览',
      'data-name':'mw75-native-instant-preview', backdrop:false,
    }, h('div', {className:css.wrap},
      h('div', {className:css.main},
        h('div', {className:css.title}, icon, title),
        h('div', {className:css.content, role:'status', 'aria-live':'polite', 'aria-atomic':true},
          h('p',{className:'mw75-summary'},system ? '行情连接暂时中断' : 'EURUSD · 1 小时'),
          h('p',null,system ? '正在自动重连，详情已记录到通知中心。' : '价格上穿 1.08500，触发价 1.08512。')),
        h('div',{className:css.footer},
          h('span',{className:'mw75-time'},'10:24'),
          !system && h('button',{type:'button',className:'mw75-detail',onClick:close},'告警记录'),
          h(Button,{type:'button',size:'m',appearance:'default',intent:'primary',onClick:close},
            system ? '查看消息' : '查看图表'))),
      h(NavButton,{'aria-label':'关闭即时通知',size:'medium',preservePaddings:true,
        className:css.close,icon:closeIcon,onClick:close,'data-name':'close','data-role':'button'})));
    if (!root) root = req(590263).createReactRoot(tree,host,'modern');
    else root.render(tree);
  }
  globalThis.nativeInstantPreview = {
    render, icons,
    dispose() {root?.unmount();host.remove();style.remove();nativeStyle.remove();window.removeEventListener('resize',position);},
  };
  render();
})();
