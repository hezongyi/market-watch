/* Mobile-only single-chart lifecycle. Never instantiate the original grid. */
globalThis.createMobileChartView = function createMobileChartView({ widget, workspace, document, capture = () => new Promise(resolve => widget.save(resolve)), selecting = () => {}, changed = () => {} }) {
  let snapshot = structuredClone(document);
  let generation = 0, disposed = false, selected = null, exploring = false, temporary = null;
  let directory = [], queue = Promise.resolve();
  const state = () => ({workspace_id: String(workspace.id), revision: workspace.revision,
    generation, selected: selected && {...selected}, exploring, temporary: !!temporary,
    directory: directory.map(row => ({...row}))});
  function waitReady(chart) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      let settled = false;
      let pollTimer;
      let deadlineTimer;
      let subscribed = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadlineTimer);
        error ? reject(error) : resolve();
      };
      const probe = () => {
        if (settled) return;
        try {
          if (chart.dataReady()) return finish();
          if (!subscribed) {
            chart.dataReady(() => finish());
            subscribed = true;
          }
        } catch (error) {
          // The public chart handle briefly exists before its model is ready.
          if (Date.now() >= deadline) return finish(Error('原图格数据加载超时'));
        }
        if (!settled) pollTimer = setTimeout(probe, 25);
      };
      deadlineTimer = setTimeout(() => finish(Error('原图格数据加载超时')), 15000);
      probe();
    });
  }
  function buildDirectory() {
    directory = MWMobileChartDocument.directory(snapshot);
    return directory.map(row => ({...row}));
  }
  async function initialize(index) {
    selected = {...directory.find(row => row.original_index === index) || directory[0]};
    exploring = false;
    await waitReady(widget.chart(0));
    await changed(state());
  }
  function select(originalIndex) {
    const token = ++generation;
    const current = () => !disposed && token === generation;
    const task = queue.then(async () => {
      if (!current()) return false;
      const row = directory.find(item => item.original_index === originalIndex);
      if (!row) throw Error('原图格不存在，请重新加载工作区');
      temporary = null; selected = null; exploring = true;
      const single = MWMobileChartDocument.project(snapshot, originalIndex);
      selecting(single);
      await widget.load(single, {uid: workspace.id, name: workspace.name});
      if (!current()) return false;
      await waitReady(widget.chart(0));
      if (!current()) return false;
      selected = {...row}; exploring = false; await changed(state(), {loaded:true});
      return true;
    });
    queue = task.catch(() => {});
    return task;
  }
  // Alert inspection changes the one live chart, never the workspace layout.
  // Keep the current view once, so repeated locations return to the same view.
  function openTemporary({symbol, resolution}) {
    const token = ++generation;
    const current = () => !disposed && token === generation;
    const task = queue.then(async () => {
      if (!current()) return false;
      const chart = widget.chart(0);
      if (!temporary) {
        const document = await capture();
        if (!current()) return false;
        temporary = {document, selected, exploring};
      }
      selected = null; exploring = true;
      selecting();
      chart.removeAllStudies(); chart.removeAllShapes();
      if (!(await chart.setSymbol(symbol))) throw Error('无法加载告警品种');
      if (!current()) return false;
      if (!(await chart.setResolution(resolution))) throw Error('无法加载告警周期');
      if (!current()) return false;
      await new Promise(resolve => chart.setChartType(1, resolve));
      await waitReady(chart);
      if (!current()) return false;
      await changed(state());
      return {chart: widget.chart(0), current};
    });
    queue = task.catch(() => {});
    return task;
  }
  function restoreTemporary() {
    const token = ++generation;
    const current = () => !disposed && token === generation;
    const task = queue.then(async () => {
      if (!current()) return false;
      if (!temporary) return true;
      const previous = temporary;
      selecting(previous.document);
      // Restore the captured single-chart document through the same public
      // load API as desktop. No multi-chart projection or template rebuild.
      await widget.load(structuredClone(previous.document), {uid: workspace.id, name: workspace.name});
      await waitReady(widget.chart(0));
      if (!current()) return false;
      selected = previous.selected; exploring = previous.exploring; temporary = null;
      await changed(state(), {loaded:true,returned:true});
      return true;
    });
    queue = task.catch(() => {});
    return task;
  }
  return {buildDirectory, initialize, select, state, openTemporary, restoreTemporary,
    acceptSaved(document, revision) {
      snapshot = structuredClone(document); workspace = {...workspace,revision}; buildDirectory();
    },
    indexForAssociation(association) {
      if (!association || association.workspace_id !== String(workspace.id)) return null;
      const row = association.chart_id
        ? directory.find(item => item.original_chart_id === association.chart_id)
        : directory.find(item => item.original_index === association.chart_index && !item.original_chart_id);
      return row ? row.original_index : null;
    },
    explore() { exploring = true; changed(state()); },
    matches(association) {
      if (disposed || exploring || !selected || association?.workspace_id !== String(workspace.id)) return false;
      return selected.original_chart_id ? association.chart_id === selected.original_chart_id :
        association.chart_index === selected.original_index;
    },
    dispose() { disposed = true; generation++; directory = []; selected = null; temporary = null; },
  };
};
