// Playwright waitForFunction treats a returned Promise as truthy before it resolves.
// Await each browser evaluation explicitly before deciding whether to retry.
module.exports = async function waitForAsync(target, predicate, arg, options = {}) {
  const deadline = Date.now() + (options.timeout ?? 30000);
  do {
    if (await target.evaluate(predicate, arg)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Async browser condition did not become true before timeout");
};
