/* Official storage adapters; user-level templates never contain workspace drawings. */
function nativePreferences(initial, rpc, readonly, report) {
  const rows = new Map(
    initial.map((row) => [JSON.stringify([row.kind, row.name, row.tool]), row]),
  );
  let writes = Promise.resolve();
  const key = (kind, name, tool = "") => JSON.stringify([kind, name, tool]);
  const list = (kind, tool = "") =>
    [...rows.values()].filter((r) => r.kind === kind && r.tool === tool);
  const get = (kind, name, tool = "") => {
    const row = rows.get(key(kind, name, tool));
    if (!row) throw Error("模板不存在或已被删除");
    return row.content.value;
  };
  function save(kind, name, value, tool = "") {
    if (readonly) return Promise.reject(Error("手机只读，不保存修改"));
    const task = writes.then(async () => {
      const old = rows.get(key(kind, name, tool));
      const row = await rpc("save", {
        kind,
        name,
        tool,
        content: { value },
        revision: old?.revision || 0,
      });
      rows.set(key(kind, name, tool), row);
    });
    writes = task.catch(() => {});
    return task;
  }
  function remove(kind, name, tool = "") {
    if (readonly) return Promise.reject(Error("手机只读，不保存修改"));
    const task = writes.then(async () => {
      const old = rows.get(key(kind, name, tool));
      if (!old) return;
      await rpc("delete", { id: old.id, revision: old.revision });
      rows.delete(key(kind, name, tool));
    });
    writes = task.catch(() => {});
    return task;
  }
  return {
    settings: {
      initialSettings: Object.fromEntries(
        list("setting").map((r) => [r.name, r.content.value]),
      ),
      setValue: (name, value) => {
        if (!readonly) save("setting", name, value).catch(report);
      },
      removeValue: (name) => {
        if (!readonly) remove("setting", name).catch(report);
      },
    },
    templates: {
      getAllStudyTemplates: async () =>
        list("study").map((r) => ({ name: r.name })),
      getStudyTemplateContent: async ({ name }) => get("study", name),
      saveStudyTemplate: ({ name, content }) => save("study", name, content),
      removeStudyTemplate: ({ name }) => remove("study", name),
      getDrawingTemplates: async (tool) =>
        list("drawing", tool).map((r) => r.name),
      loadDrawingTemplate: async (tool, name) => get("drawing", name, tool),
      saveDrawingTemplate: (tool, name, content) =>
        save("drawing", name, content, tool),
      removeDrawingTemplate: (tool, name) => remove("drawing", name, tool),
      getAllChartTemplates: async () => list("chart").map((r) => r.name),
      getChartTemplateContent: async (name) => ({
        content: get("chart", name),
      }),
      saveChartTemplate: (name, content) => save("chart", name, content),
      removeChartTemplate: (name) => remove("chart", name),
    },
  };
}
