/* Server-backed user preference; manual saves do not depend on this timer. */
function chartAutoSave(initial, persist, save, readonly) {
  let enabled = !readonly && initial.find(row => row.kind === "setting" &&
    row.name === "mw.autoSave")?.content.value === true;
  let timer;
  const reset = () => {
    clearInterval(timer);
    timer = enabled ? setInterval(save, 30000) : undefined;
  };
  reset();
  return {
    get enabled() { return enabled; },
    readonly,
    async select(next) {
      if (readonly || enabled === next) return;
      await persist(next);
      enabled = next;
      reset();
    },
    dispose() { clearInterval(timer); },
  };
}
