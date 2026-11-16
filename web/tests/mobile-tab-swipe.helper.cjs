const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
let shotId = 0;

async function swipeContent(page, context, root, dx, dy = 4, motion = false) {
  const track = root.locator('[data-slot="carousel-content"] > div');
  await page.waitForTimeout(550);
  const original = motion ? await track.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41) : 0;
  const frames = [];
  if (motion && dx < 0) {
    const selected = await root.getByRole('tab', {selected:true}).getAttribute('data-tab-value');
    const previews = await root.locator('[data-slot="carousel-item"]').evaluateAll(slides => slides.map(slide => ({
      value: slide.firstElementChild?.getAttribute('aria-labelledby'),
      height: slide.firstElementChild?.getBoundingClientRect().height || 0,
      display: slide.firstElementChild && getComputedStyle(slide.firstElementChild).display,
    })));
    const index = await root.getByRole('tab').evaluateAll((tabs,value) => tabs.findIndex(tab=>tab.dataset.tabValue===value),selected);
    assert(previews[index+1]?.height > 20 && previews[index+1]?.display !== 'none', 'adjacent page is rendered during the drag, not a blank gap');
  }
  const panel = root.locator('[data-slot="tabs-content"]:not([hidden])').first();
  const box = await root.locator('[data-slot="carousel-content"]').boundingBox();
  assert(box && box.height > 10, 'visible tab content has a gesture area');
  const x = dx < 0 ? box.x + box.width * .4 : box.x + box.width * .3;
  const y = box.y + Math.min(120, box.height / 2);
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6 }] });
      await page.waitForTimeout(32);
      if (motion && step === 4 && process.env.MOBILE_TAB_MOTION_OUTPUT) {
        const out = process.env.MOBILE_TAB_MOTION_OUTPUT; fs.mkdirSync(out, {recursive:true});
        const name = (await root.getAttribute('class')).replace(/[^a-zA-Z0-9-]/g,'-');
        await page.screenshot({path:path.join(out,name+'-'+(++shotId)+'-drag.png')});
      }
      if (motion) frames.push(await track.evaluate((el, original) => ({
        x: new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 - original,
        selected: el.closest('[data-slot="tabs"]').querySelector('[aria-selected="true"]').dataset.tabValue,
      }), original));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
  await page.waitForTimeout(550);
  if (motion) {
    const distance = Math.max(...frames.map(frame => Math.abs(frame.x)));
    assert(distance > Math.abs(dx) * .5 && distance < Math.abs(dx) * 1.5, JSON.stringify({message:'content follows finger before release',dx,frames}));
    assert(frames.every(frame => frame.selected === frames[0].selected), 'no page activation or request before release');
    await expect.poll(async () => {
      const panel = root.getByRole('tabpanel');
      const viewport = root.locator('[data-slot="carousel-content"]');
      return Math.abs((await panel.boundingBox()).x - (await viewport.boundingBox()).x);
    }).toBeLessThan(1);
    console.log('MOTION '+JSON.stringify({dx,frames}));
  }
}

async function verifySwipeTabs({ page, context, root, full = false }) {
  const tabs = root.getByRole('tab');
  const first = tabs.first(), second = tabs.nth(1);
  await first.click();
  await swipeContent(page, context, root, -100, 4, full);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await swipeContent(page, context, root, 100);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await swipeContent(page, context, root, 100);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  if (!full) return;
  // Short and diagonal movement must not turn a page.
  await swipeContent(page, context, root, -25, 4, true);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await swipeContent(page, context, root, -95, 110);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  const panel = root.locator('[data-slot="tabs-content"]:not([hidden])').first();
  async function synthetic(mode) {
    await panel.evaluate((el, mode) => {
      const touch = (x, y, id = 1) => new Touch({ identifier: id, target: el, clientX: x, clientY: y });
      const emit = (type, touches) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches }));
      const startX = mode === 'edge' ? 5 : 240;
      emit('touchstart', [touch(startX, 300)]);
      if (mode === 'vertical-lock') emit('touchmove', [touch(startX - 2, 330)]);
      if (mode === 'multi') emit('touchmove', [touch(startX, 300), touch(startX - 10, 320, 2)]);
      emit('touchmove', [touch(startX - 120, 304)]);
      emit(mode === 'cancel' ? 'touchcancel' : 'touchend', []);
      if (mode === 'cancel') emit('touchend', []);
    }, mode);
    await expect(first).toHaveAttribute('aria-selected', 'true');
  }
  for (const mode of ['edge', 'cancel', 'multi', 'vertical-lock']) await synthetic(mode);
  await tabs.last().click();
  await swipeContent(page, context, root, -100);
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  // Native click and keyboard remain usable alongside the extra gesture.
  await first.click();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  if (await second.getAttribute('aria-selected') !== 'true') await page.keyboard.press('Enter');
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await first.click();
  await second.click();
  await tabs.last().click();
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => Math.abs((await root.getByRole('tabpanel').boundingBox()).x - (await root.locator('[data-slot="carousel-content"]').boundingBox()).x)).toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  await second.click();
  await expect.poll(async () => Math.abs((await root.getByRole('tabpanel').boundingBox()).x - (await root.locator('[data-slot="carousel-content"]').boundingBox()).x)).toBeLessThan(1);
  await first.click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}
module.exports = { swipeContent, verifySwipeTabs };
