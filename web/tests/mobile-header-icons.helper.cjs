const assert = require('node:assert/strict');

// Inspect actual targets, including page CSS overrides and portal themes.
async function auditHeaderIcons(page) {
  const groups = await page.locator('.mobile-controls :is(.mobile-header-actions,.data-header-actions,.alert-header-actions,.mobile-drawer-actions)').evaluateAll(nodes => nodes
    .filter(node => node.getClientRects().length && !node.closest('[hidden],[aria-hidden="true"],[inert],[data-ending-style]'))
    .map(group => ({
      gap: getComputedStyle(group).columnGap,
      buttons: [...group.querySelectorAll('button')].map(button => {
        const css = getComputedStyle(button), svg = button.querySelector('svg'), box = button.getBoundingClientRect();
        const probe = document.createElement('span'); probe.style.color = button.dataset.active ? 'var(--accent)' : 'var(--text)'; button.append(probe);
        const expectedColor = getComputedStyle(probe).color; probe.remove();
        return {
          label: button.getAttribute('aria-label'), shared: button.classList.contains('mobile-header-icon'),
          width: box.width, height: box.height, x: box.x,
          background: css.backgroundColor, border: css.borderWidth, color: css.color, expectedColor,
          svg: svg && {width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, stroke: getComputedStyle(svg).strokeWidth},
          dots: button.querySelectorAll('.mobile-header-icon-dot').length, active: !!button.dataset.active,
          icon: svg && svg.getAttribute('class'),
        };
      }),
    })));
  const expectedIcons = {'添加自选':'plus','添加自建':'plus','创建告警':'plus','搜索自建行情':'search','搜索规则':'search','增强搜索':'list-filter','关闭':'x','新建分组':'folder-plus','管理自选':'sliders-horizontal'};
  for (const group of groups) {
    assert.equal(group.gap, '4px', 'shared header action spacing');
    for (const b of group.buttons) {
      assert(b.label && b.shared, JSON.stringify(b));
      assert.equal(b.width, 44, b.label+' touch width'); assert.equal(b.height, 44, b.label+' touch height');
      assert.equal(b.background, 'rgba(0, 0, 0, 0)', b.label+' transparent background'); assert.equal(b.border,'0px');
      assert.equal(b.color,b.expectedColor,b.label+' semantic foreground');
      assert.deepEqual(b.svg,{width:22,height:22,stroke:'1.75px'},b.label+' icon geometry');
      assert.equal(b.dots,Number(b.active),b.label+' effective conditions marker');
      if (expectedIcons[b.label]) assert(b.icon.split(' ').includes('lucide-'+expectedIcons[b.label]),b.label+' action icon');
    }
    for (let i=1;i<group.buttons.length;i++) assert(Math.abs(group.buttons[i].x-group.buttons[i-1].x-48)<.1,'stable 44px targets and 4px gap');
  }
  return groups;
}
async function checkHeaderFeedback(page, button) {
  await page.keyboard.press('Tab'); await button.focus();
  assert(await button.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineWidth === '2px'),'visible keyboard focus');
  for (const reducedMotion of ['no-preference','reduce']) {
    await page.emulateMedia({reducedMotion});
    const before = await button.boundingBox();
    await page.mouse.move(before.x+22,before.y+22); await page.mouse.down(); await page.waitForTimeout(180);
    const pressed = await button.boundingBox();
    assert.deepEqual(pressed,before,'press does not move the target');
    const css = await button.evaluate(el => ({opacity:getComputedStyle(el).opacity,background:getComputedStyle(el).backgroundColor,icon:getComputedStyle(el.querySelector('svg')).transform,duration:getComputedStyle(el.querySelector('svg')).transitionDuration}));
    assert.equal(css.opacity,'0.6'); assert.equal(css.background,'rgba(0, 0, 0, 0)');
    if(reducedMotion==='reduce') {assert.equal(css.icon,'none');assert.equal(css.duration,'0s');}
    else assert(css.icon.startsWith('matrix(0.92'),'light icon press scale');
    await page.mouse.move(1,1); await page.mouse.up(); await page.waitForTimeout(150);
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
}
module.exports = {auditHeaderIcons,checkHeaderFeedback};
