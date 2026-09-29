/* Revisions stay pinned until explicit load/save; listing cannot authorize overwrite. */
function nativeWorkspaces(initial, rpc, readonly, onLoaded, onSaved) {
  const revisions = new Map();
  if (initial?.id) revisions.set(String(initial.id), initial.revision);
  let writes = Promise.resolve();
  return {
    getAllCharts: async () => {
      const rows = await rpc("list", {});
      for (const row of rows)
        if (!revisions.has(String(row.id)))
          revisions.set(String(row.id), row.revision);
      return rows.map(({ revision, ...meta }) => meta);
    },
    getChartContent: (id) => {
      const task = writes.then(async () => {
        const row = await rpc("load", { id: String(id) });
        revisions.set(String(id), row.revision);
        onLoaded(row);
        return row.content;
      });
      writes = task.catch(() => {});
      return task;
    },
    saveChart: (data) => {
      if (readonly) return Promise.reject(Error("手机只读，不保存修改"));
      const task = writes.then(async () => {
        const id = data.id == null ? null : String(data.id);
        if (id && !revisions.has(id)) throw Error("请先加载工作区再保存");
        const row = await rpc("save", {
          id,
          name: data.name,
          symbol: data.symbol,
          resolution: data.resolution,
          content: data.content,
          revision: id ? revisions.get(id) : 0,
        });
        revisions.set(String(row.id), row.revision);
        onSaved(row);
        return row.id;
      });
      writes = task.catch(() => {});
      return task;
    },
    removeChart: (id) => {
      if (readonly) return Promise.reject(Error("手机只读，不能删除工作区"));
      const task = writes.then(async () => {
        id = String(id);
        if (!revisions.has(id)) throw Error("请刷新工作区列表");
        await rpc("delete", { id, revision: revisions.get(id) });
        revisions.delete(id);
      });
      writes = task.catch(() => {});
      return task;
    },
  };
}
