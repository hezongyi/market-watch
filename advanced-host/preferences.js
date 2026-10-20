/* Official storage adapters; user-level templates never contain workspace drawings. */
function nativePreferences(
  initial,
  rpc,
  readonly,
  report,
  recovered = () => {},
  captureScope = () => undefined,
) {
  const rows = new Map(
    initial.map((row) => [JSON.stringify([row.kind, row.name, row.tool]), row]),
  );
  // Remote revisions and the content this window actually observed are separate.
  // Refreshing a revision must never silently authorize overwriting a new value.
  const baseline = new Map(rows),
    pending = new Map();
  let writes = Promise.resolve();
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
          "；请保留当前修改，重新加载后核对。",
      ),
      { status: error?.status, code: error?.code },
    );
  }
  const list = (kind, tool = "") =>
    [...rows.values()].filter((r) => r.kind === kind && r.tool === tool);
  const get = (kind, name, tool = "") => {
    const row = rows.get(key(kind, name, tool));
    if (!row) throw Error("模板不存在或已被删除");
    return row.content.value;
  };
  function save(kind, name, value, tool = "") {
    if (readonly) return Promise.reject(unsaved(Error("手机只读，不保存修改")));
    const task = writes.then(async () => {
      const k = key(kind, name, tool),
        base = baseline.get(k);
      pending.set(k, value);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await refresh();
          const old = rows.get(k);
          if (old && same(old.content.value, value)) {
            baseline.set(k, old);
            pending.delete(k);
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
            // A successful merge does not update the chart's in-memory settings.
            // Its next callback still includes untouched fields from `value`.
            // Keep that observed content as the local baseline so it cannot
            // undo fields contributed by another window on the next save.
            baseline.set(k, { ...row, content: { ...row.content, value } });
            pending.delete(k);
            return;
          } catch (error) {
            if (error?.status !== 409 || attempt === 1) throw error;
          }
        }
      } catch (error) {
        throw unsaved(error);
      }
    });
    writes = task.catch(() => {});
    return task;
  }
  function remove(kind, name, tool = "") {
    if (readonly) return Promise.reject(unsaved(Error("手机只读，不保存修改")));
    const task = writes.then(async () => {
      const k = key(kind, name, tool),
        base = baseline.get(k);
      try {
        await refresh();
        const old = rows.get(k);
        if (!old) {
          baseline.delete(k);
          return;
        }
        if (!base || !same(base.content.value, old.content.value))
          throw Error("该设置或模板已在其他窗口修改");
        await rpc("delete", { id: old.id, revision: old.revision });
        rows.delete(k);
        baseline.delete(k);
        pending.delete(k);
      } catch (error) {
        throw unsaved(error);
      }
    });
    writes = task.catch(() => {});
    return task;
  }
  // The pinned library converts adapter rejections into fulfilled error objects
  // and can close its native template dialog. Surface failure independently.
  const templateWrite = (promise, context) => {
    const scope = captureScope();
    return promise
      .then((result) => {
        recovered(context, scope);
        return result;
      })
      .catch((error) => {
        report(error, context, scope);
        throw error;
      });
  };
  return {
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
        if (!readonly)
          templateWrite(save("setting", name, value), {
            kind: "setting",
            name,
            operation: "save",
          }).catch(() => {});
      },
      removeValue: (name) => {
        if (!readonly)
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
