/* Persist native lists as one versioned user preference; never part of a layout. */
async function nativeWatchlists(widget, initial, readonly, save, report) {
  const api = await widget.watchList();
  let timer;
  const later = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stored = initial && Array.isArray(initial.lists) ? initial : null;
  if (stored) {
    // Native getActive destructures the first list even when no active ID is
    // available. Install replacements before removing obsolete lists.
    const lists = stored.lists.length
      ? stored.lists
      : [
          {
            id: "mw-empty-watchlist",
            title: "自选列表",
            symbols: [],
          },
        ];
    for (const list of lists) api.saveList(list);
    await later();
    const ids = new Set(lists.map((list) => list.id));
    api.setActiveList(ids.has(stored.active) ? stored.active : lists[0].id);
    for (const list of Object.values(api.getAllLists() || {}))
      if (!ids.has(list.id)) api.deleteList(list.id);
    await later();
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
