/* Official storage adapters; user-level templates never contain workspace drawings. */
function nativePreferences(
  initial,
  rpc,
  readonly,
  report,
  recovered = () => {},
  captureScope = () => undefined,
  durability = null,
) {
  const rows = new Map(
    initial.map((row) => [JSON.stringify([row.kind, row.name, row.tool]), row]),
  );
  // Remote revisions and the content this window actually observed are separate.
  // Refreshing a revision must never silently authorize overwriting a new value.
  const baseline = new Map(rows),
    pending = new Map();
  let writes = Promise.resolve();
  const activeWrites = new Map(), resolving = new Set(), resolved = new Set();
  const restored = new Set(durability?.blocked || []);
  const reported = new Map();
  const touched = new Set();
  let disposed = false;
  const revisionChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("mw-preference-revisions-v1");
  // Revision messages are hints only; content always comes from authenticated
  // reads. Never advance the baseline of settings already loaded by the widget.
  if (revisionChannel) revisionChannel.onmessage = ({data}) => {
    if (disposed || !data || typeof data.key !== 'string' || data.key.length > 1000 || !Number.isSafeInteger(data.revision) || data.revision < 0 || touched.has(data.key)) return;
    const apply = async () => {
      if (disposed || touched.has(data.key)) return;
      const latest = await rpc('read', {});
      if (disposed || touched.has(data.key)) return;
      const row = latest.find(row => key(row.kind, row.name, row.tool) === data.key);
      if (row) rows.set(data.key, row); else rows.delete(data.key);
    };
    writes = writes.then(apply).catch(() => {});
  };
  const changed = (k, revision) => {
    if (!disposed) revisionChannel?.postMessage({key:k, revision});
  };
  const key = (kind, name, tool = "") => JSON.stringify([kind, name, tool]);
  const mergeable = new Set([
    "widgetbar.layout-settings",
    "chartproperties",
    "chartproperties.mainSeriesProperties",
  ]);
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, stable(value[k])]),
          )
        : value;
  const same = (a, b) =>
    JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const decode = (value) => {
    try {
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
      return value;
    }
  };
  function merge(base, wanted, remote, depth = 0) {
    if (same(wanted, remote) || same(base, remote))
      return { ok: true, value: wanted };
    if (same(base, wanted)) return { ok: true, value: remote };
    const object = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (depth > 8 || ![base, wanted, remote].every(object))
      return { ok: false };
    const entries = [];
    for (const k of new Set([
      ...Object.keys(base),
      ...Object.keys(wanted),
      ...Object.keys(remote),
    ])) {
      const part = merge(base[k], wanted[k], remote[k], depth + 1);
      if (!part.ok) return { ok: false };
      if (part.value !== undefined) entries.push([k, part.value]);
    }
    return { ok: true, value: Object.fromEntries(entries) };
  }
  async function refresh(kind) {
    const latest = await rpc("read", {});
    rows.clear();
    for (const row of latest) rows.set(key(row.kind, row.name, row.tool), row);
    if (kind) {
      for (const [k, row] of baseline)
        if (row.kind === kind) baseline.delete(k);
      for (const [k, row] of rows) if (row.kind === kind) baseline.set(k, row);
    }
  }
  function unsaved(error) {
    return Object.assign(
      Error(
        "设置未保存：" +
          String(error?.message || error) +
          "；请在“处理设置草稿”中核对并选择保留的设置。",
      ),
      { status: error?.status || (/其他窗口/.test(String(error)) ? 409 : undefined), code: error?.code || (/其他窗口/.test(String(error)) ? "PREFERENCE_REVISION_CONFLICT" : "PREFERENCE_SAVE_FAILED") },
    );
  }
  const list = (kind, tool = "") =>
    [...rows.values()].filter((r) => r.kind === kind && r.tool === tool);
  const get = (kind, name, tool = "") => {
    const row = rows.get(key(kind, name, tool));
    if (!row) throw Error("模板不存在或已被删除");
    return row.content.value;
  };
  function save(kind, name, value, tool = "", recoveryDraft = null) {
    if (readonly) return Promise.reject(unsaved(Error("手机只读，不保存修改")));
    const k = key(kind, name, tool);
    if (!recoveryDraft && (resolving.has(k) || resolved.has(k))) return Promise.reject(unsaved(Error("设置草稿正在处理或已处理；重新打开图表后继续修改")));
    if (!recoveryDraft && restored.has(k)) return Promise.reject(unsaved(Error("此设置有尚未处理的本地草稿")));
    touched.add(k);
    const active = activeWrites.get(k);
    if (active && same(active.value, value)) return active.task;
    const version = globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random();
    let draft = recoveryDraft || {key:k, version, kind, name, tool, value, base:baseline.get(k), operation:'save'};
    // Persist at enqueue time, before waiting for earlier network operations.
    let durable = durability && !recoveryDraft ? durability.put(draft) : Promise.resolve();
    durable.catch(() => {});
    pending.set(k, value);
    // Collapse a burst while this key is still queued; persist every latest
    // value immediately, and never merge across an intervening delete.
    if (!recoveryDraft && active && !active.started) {
      Object.assign(active, {value, draft, durable});
      return active.task;
    }
    const entry = {value, draft, durable, started:false, task:null};
    const run = async () => {
      entry.started = true;
      ({value, draft, durable} = entry);
      const base = baseline.get(k);
      try { await durable; } catch { throw unsaved(Error("本机草稿写入失败，请勿关闭页面")); }
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await refresh();
          const old = rows.get(k);
          if (old && same(old.content.value, value)) {
            baseline.set(k, old);
            if (same(pending.get(k), value)) pending.delete(k);
            if (durability) await durability.drop(draft);
            return;
          }
          if ((base && !old) || (!base && old))
            throw Error("该设置已在其他窗口修改或删除");
          let content = value;
          if (base && old && !same(base.content.value, old.content.value)) {
            if (kind !== "setting" || !mergeable.has(name))
              throw Error("同一设置或模板已在其他窗口修改");
            const result = merge(
              decode(base.content.value),
              decode(value),
              decode(old.content.value),
            );
            if (!result.ok) throw Error("同一字段已在其他窗口修改");
            content =
              typeof value === "string"
                ? JSON.stringify(result.value)
                : result.value;
          }
          try {
            const row = await rpc("save", {
              kind,
              name,
              tool,
              content: { value: content },
              revision: old?.revision || 0,
            });
            rows.set(k, row);
            changed(k, row.revision);
            // A successful merge does not update the chart's in-memory settings.
            // Its next callback still includes untouched fields from `value`.
            // Keep that observed content as the local baseline so it cannot
            // undo fields contributed by another window on the next save.
            baseline.set(k, { ...row, content: { ...row.content, value } });
            if (same(pending.get(k), value)) pending.delete(k);
            if (durability) await durability.drop(draft);
            return;
          } catch (error) {
            if (error?.status !== 409 || attempt === 1) throw error;
          }
        }
      } catch (error) {
        try { await durability?.failed?.(draft); } catch { /* Preserve the original failure and recover the durable draft on reload. */ }
        throw unsaved(error);
      }
    };
    const task = recoveryDraft ? run() : writes.then(run);
    entry.task = task;
    activeWrites.set(k, entry);
    const clear = () => { if (activeWrites.get(k)?.task === task) activeWrites.delete(k); };
    task.then(clear, clear);
    if (!recoveryDraft) writes = task.catch(() => {});
    return task;
  }
  function remove(kind, name, tool = "", recoveryDraft = null) {
    if (readonly) return Promise.reject(unsaved(Error("手机只读，不保存修改")));
    const k = key(kind,name,tool);
    if (!recoveryDraft && (resolving.has(k) || resolved.has(k))) return Promise.reject(unsaved(Error("设置草稿正在处理或已处理；重新打开图表后继续修改")));
    if (!recoveryDraft && restored.has(k)) return Promise.reject(unsaved(Error("此设置有尚未处理的本地草稿")));
    touched.add(k);
    activeWrites.delete(k);
    const draft = recoveryDraft || {key:k,version:globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random(),kind,name,tool,base:baseline.get(k),operation:'delete'};
    const durable = durability && !recoveryDraft ? durability.put(draft) : Promise.resolve();
    durable.catch(() => {});
    const run = async () => {
      const k = key(kind, name, tool), base = baseline.get(k);
      try {
        await durable;
        await refresh();
        const old = rows.get(k);
        if (!old) {
          baseline.delete(k);
          if (durability) await durability.drop(draft);
          return;
        }
        if (!base || !same(base.content.value, old.content.value))
          throw Error("该设置或模板已在其他窗口修改");
        await rpc("delete", { id: old.id, revision: old.revision });
        rows.delete(k);
        changed(k, 0);
        baseline.delete(k);
        pending.delete(k);
        if (durability) await durability.drop(draft);
      } catch (error) {
        try { await durability?.failed?.(draft); } catch { /* Preserve the original failure and recover the durable draft on reload. */ }
        throw unsaved(error);
      }
    };
    const task = recoveryDraft ? run() : writes.then(run);
    if (!recoveryDraft) writes = task.catch(() => {});
    return task;
  }
  // The pinned library converts adapter rejections into fulfilled error objects
  // and can close its native template dialog. Surface failure independently.
  const templateWrite = (promise, context) => {
    const scope = captureScope();
    return promise
      .then((result) => {
        reported.delete(JSON.stringify(context));
        recovered(context, scope);
        return result;
      })
      .catch((error) => {
        const k = JSON.stringify(context), signature = String(error);
        if (reported.get(k) !== signature) {
          reported.set(k, signature);
          report(error, {...context, revision:baseline.get(key(context.kind,context.name,context.tool || ""))?.revision}, scope);
        }
        throw error;
      });
  };
  return {
    dispose() { disposed = true; revisionChannel?.close(); },
    resolveDraft(draft, action, revision) {
      const k = key(draft.kind, draft.name, draft.tool);
      if (resolving.has(k)) return Promise.reject(Error("此草稿正在处理"));
      // Freeze callbacks synchronously, before yielding to the queue/network.
      // The old widget must stay frozen until reopening applies the choice.
      resolving.add(k);
      const task = writes.then(async () => {
        await refresh();
        if (durability?.current && !await durability.current(draft)) throw unsaved(Error("本地草稿再次变化，请重新选择草稿"));
        const remote = rows.get(k);
        if ((remote?.revision || 0) !== revision) throw unsaved(Error("服务器设置再次变化，请重新查看差异"));
        if (!['local','remote'].includes(action)) throw Error("无效草稿操作");
        if (remote) baseline.set(k, remote); else baseline.delete(k);
        if (action === 'local') {
          const context = {kind:draft.kind,name:draft.name,tool:draft.tool,operation:draft.operation};
          if (draft.operation === 'delete') await templateWrite(remove(draft.kind,draft.name,draft.tool,draft), context);
          else await templateWrite(save(draft.kind,draft.name,draft.value,draft.tool,draft), context);
        } else {
          pending.delete(k);
          await durability?.drop(draft);
          durability?.abandoned?.({kind:draft.kind,name:draft.name,tool:draft.tool,operation:draft.operation});
        }
        restored.delete(k);
        resolved.add(k);
      });
      writes = task.catch(() => {});
      task.then(()=>resolving.delete(k),()=>resolving.delete(k));
      return task;
    },
    savePreference: (kind, name, value, tool = "") =>
      templateWrite(save(kind, name, value, tool), {
        kind,
        name,
        tool,
        operation: "save",
      }),
    settings: {
      initialSettings: Object.fromEntries(
        list("setting")
          .filter((r) => !r.name.startsWith("mw."))
          .map((r) => [r.name, r.content.value]),
      ),
      setValue: (name, value) => {
        if (!readonly && !restored.has(key("setting", name)) && !resolving.has(key("setting", name)) && !resolved.has(key("setting", name)))
          templateWrite(save("setting", name, value), {
            kind: "setting",
            name,
            operation: "save",
          }).catch(() => {});
      },
      removeValue: (name) => {
        if (!readonly && !restored.has(key("setting", name)) && !resolving.has(key("setting", name)) && !resolved.has(key("setting", name)))
          templateWrite(remove("setting", name), {
            kind: "setting",
            name,
            operation: "delete",
          }).catch(() => {});
      },
    },
    templates: {
      getAllStudyTemplates: async () => {
        await refresh("study");
        return list("study").map((r) => ({ name: r.name }));
      },
      getStudyTemplateContent: async ({ name }) => {
        await refresh("study");
        return get("study", name);
      },
      saveStudyTemplate: ({ name, content }) =>
        templateWrite(save("study", name, content), {
          kind: "study",
          name,
          operation: "save",
        }),
      removeStudyTemplate: ({ name }) =>
        templateWrite(remove("study", name), {
          kind: "study",
          name,
          operation: "delete",
        }),
      getDrawingTemplates: async (tool) => {
        await refresh("drawing");
        return list("drawing", tool).map((r) => r.name);
      },
      loadDrawingTemplate: async (tool, name) => {
        await refresh("drawing");
        return get("drawing", name, tool);
      },
      saveDrawingTemplate: (tool, name, content) =>
        templateWrite(save("drawing", name, content, tool), {
          kind: "drawing",
          name,
          tool,
          operation: "save",
        }),
      removeDrawingTemplate: (tool, name) =>
        templateWrite(remove("drawing", name, tool), {
          kind: "drawing",
          name,
          tool,
          operation: "delete",
        }),
      getAllChartTemplates: async () => {
        await refresh("chart");
        return list("chart").map((r) => r.name);
      },
      getChartTemplateContent: async (name) => {
        await refresh("chart");
        return { content: get("chart", name) };
      },
      saveChartTemplate: (name, content) =>
        templateWrite(save("chart", name, content), {
          kind: "chart",
          name,
          operation: "save",
        }),
      removeChartTemplate: (name) =>
        templateWrite(remove("chart", name), {
          kind: "chart",
          name,
          operation: "delete",
        }),
    },
  };
}
