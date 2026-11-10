// Embedded by patch-native-toolset.mjs; keep this function self-contained.
export function subscribeToolbarSymbol(activeWidget, onResolved) {
  let disposed = false;
  let widget, modelCreated, symbolResolved;

  const unbindSymbol = () => {
    symbolResolved?.unsubscribe(null, onResolved);
    symbolResolved = undefined;
  };
  const bindModel = () => {
    if (disposed) return;
    unbindSymbol();
    if (!widget?.hasModel()) return;
    symbolResolved = widget.model().mainSeries().symbolResolved();
    symbolResolved.subscribe(null, onResolved, false);
    // A restored or newly active model may have resolved before we subscribed.
    onResolved();
  };
  const bindWidget = () => {
    if (disposed) return;
    modelCreated?.unsubscribe(null, bindModel);
    unbindSymbol();
    widget = activeWidget.value();
    modelCreated = widget?.modelCreated();
    modelCreated?.subscribe(null, bindModel, false);
    bindModel();
  };

  activeWidget.subscribe(bindWidget);
  bindWidget();
  return () => {
    disposed = true;
    activeWidget.unsubscribe(bindWidget);
    modelCreated?.unsubscribe(null, bindModel);
    modelCreated = undefined;
    unbindSymbol();
    widget = undefined;
  };
}
