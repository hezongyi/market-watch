import assert from 'node:assert/strict';
import test from 'node:test';
import {subscribeToolbarSymbol} from '../../advanced-host/native-toolbar-lifetime.mjs';

function event() {
  const listeners = new Set();
  return {
    listeners,
    subscribe(context, callback) {
      assert.equal(context, null);
      listeners.add(callback);
    },
    unsubscribe(context, callback) {
      assert.equal(context, null);
      listeners.delete(callback);
    },
    fire() { for (const callback of [...listeners]) callback(); },
  };
}

function chart(ready = false) {
  const created = event();
  let resolved = event();
  let reads = 0;
  return {
    created,
    get resolved() { return resolved; },
    get reads() { return reads; },
    hasModel: () => ready,
    modelCreated: () => created,
    model() {
      reads++;
      if (!ready) throw Error('Value is null');
      return {mainSeries: () => ({symbolResolved: () => resolved})};
    },
    attach() { ready = true; created.fire(); },
    detach() { ready = false; },
    replaceModel() { resolved = event(); this.attach(); },
  };
}

function active(initial) {
  const listeners = new Set();
  let current = initial;
  return {
    listeners,
    value: () => current,
    subscribe: callback => listeners.add(callback),
    unsubscribe: callback => listeners.delete(callback),
    set(value) { current = value; for (const callback of [...listeners]) callback(); },
  };
}

test('mount waits for the model and keeps receiving resolved symbol updates', () => {
  const widget = chart(), selected = active(widget);
  let updates = 0;
  const dispose = subscribeToolbarSymbol(selected, () => updates++);
  assert.equal(widget.reads, 0, 'toolbar must not read the pending model');
  assert.equal(updates, 0);
  widget.attach();
  assert.equal(updates, 1, 'refresh a symbol that may already be resolved');
  widget.resolved.fire();
  assert.equal(updates, 2, 'a guard alone would miss this event');
  dispose();
  assert.equal(widget.created.listeners.size, 0);
  assert.equal(widget.resolved.listeners.size, 0);
  assert.equal(selected.listeners.size, 0);
});

test('already ready and newly active charts bind even without a symbol change', () => {
  const first = chart(true), second = chart(true), selected = active(first);
  let updates = 0;
  const dispose = subscribeToolbarSymbol(selected, () => updates++);
  assert.equal(updates, 1);
  selected.set(second);
  assert.equal(first.created.listeners.size, 0);
  assert.equal(first.resolved.listeners.size, 0);
  assert.equal(second.resolved.listeners.size, 1);
  first.resolved.fire();
  assert.equal(updates, 2);
  second.resolved.fire();
  assert.equal(updates, 3);
  dispose();
});

test('switching away from a pending chart cancels its model wait', () => {
  const first = chart(), second = chart(), selected = active(first);
  let updates = 0;
  const dispose = subscribeToolbarSymbol(selected, () => updates++);
  selected.set(second);
  first.attach();
  assert.equal(first.reads, 0);
  assert.equal(updates, 0);
  second.attach();
  assert.equal(updates, 1);
  dispose();
});

test('same chart model replacement releases the original event delegate', () => {
  const widget = chart(true), selected = active(widget);
  let updates = 0;
  const dispose = subscribeToolbarSymbol(selected, () => updates++);
  const oldResolved = widget.resolved;
  widget.replaceModel();
  assert.equal(oldResolved.listeners.size, 0);
  assert.equal(widget.resolved.listeners.size, 1);
  oldResolved.fire();
  assert.equal(updates, 2);
  widget.resolved.fire();
  assert.equal(updates, 3);
  widget.detach();
  const reads = widget.reads;
  dispose();
  assert.equal(widget.reads, reads, 'unmount cannot look up a destroyed model');
});

test('unmount before ready cancels callbacks, including a previously captured callback', () => {
  const widget = chart(), selected = active(widget);
  let updates = 0;
  const dispose = subscribeToolbarSymbol(selected, () => updates++);
  const late = [...widget.created.listeners][0];
  dispose();
  widget.attach();
  late();
  selected.set(chart(true));
  dispose();
  assert.equal(widget.reads, 0);
  assert.equal(updates, 0);
  assert.equal(widget.created.listeners.size, 0);
  assert.equal(selected.listeners.size, 0);
});

test('an empty active slot can acquire and release a chart over repeated lifetimes', () => {
  const selected = active(undefined);
  for (let i = 0; i < 20; i++) {
    const dispose = subscribeToolbarSymbol(selected, () => {});
    const widget = chart();
    selected.set(widget);
    widget.attach();
    selected.set(undefined);
    assert.equal(widget.created.listeners.size, 0);
    assert.equal(widget.resolved.listeners.size, 0);
    dispose();
    assert.equal(selected.listeners.size, 0);
  }
});
