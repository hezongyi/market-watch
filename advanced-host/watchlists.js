/* Persist native lists as one versioned user preference; never part of a layout. */
async function nativeWatchlists(widget, initial, readonly, save, report) {
  const api = await widget.watchList();
  let timer;
  const later = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stored = initial && Array.isArray(initial.lists) ? initial : null;
  if (stored) {
    for (const list of Object.values(api.getAllLists() || {}))
      api.deleteList(list.id);
    await later();
    for (const list of stored.lists) api.saveList(list);
    await later();
    if (stored.active && api.getAllLists()?.[stored.active])
      api.setActiveList(stored.active);
  } else {
    const id = api.getActiveListId();
    if (id && !(api.getList(id) || []).length)
      api.updateList(id, ["EURUSD", "XAUUSD", "BTCUSDT"]);
    await later();
  }
  const snapshot = () => ({
    lists: Object.values(api.getAllLists() || {}),
    active: api.getActiveListId(),
  });
  let previous = stored ? JSON.stringify(stored) : "";
  let saving = false;
  let changedWhileSaving = false;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (saving) {
        changedWhileSaving = true;
        return;
      }
      const encoded = JSON.stringify(snapshot());
      if (encoded === previous) return;
      saving = true;
      try {
        await save(JSON.parse(encoded));
        previous = encoded;
      } catch (e) {
        report(e);
      } finally {
        saving = false;
        if (changedWhileSaving) {
          changedWhileSaving = false;
          persist();
        }
      }
    }, 100);
  };
  if (!readonly) {
    for (const event of [
      "onListChanged",
      "onActiveListChanged",
      "onListAdded",
      "onListRemoved",
      "onListRenamed",
    ])
      api[event]().subscribe(null, persist);
    persist();
  }
}
