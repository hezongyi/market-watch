/* The widget theme colors the chrome; saved_data also restores canvas colors.
 * Keep a theme marker beside each layout so a newer account preference can be
 * applied without resetting custom colors saved in the same theme. */
function chartThemeName(value) {
  return typeof value === "string" && /^(dark|light)$/i.test(value)
    ? value.toLowerCase() === "dark" ? "Dark" : "Light"
    : undefined;
}

function chartInitialTheme(preferences, document, state) {
  const value = name => preferences.find(row => row.kind === "setting" && row.name === name)?.content.value;
  return chartThemeName(value("mw.theme")) || chartThemeName(value("current_theme.name")) ||
    chartThemeName(state?._mwTheme) || chartThemeName(document.theme) || "Dark";
}

async function restoreChartTheme(widget, state, theme) {
  const savedTheme = chartThemeName(state?._mwTheme);
  if (savedTheme === theme) return;
  let change = !!savedTheme;
  if (!savedTheme) {
    // Old layouts have no marker. Repair only recognizable native defaults;
    // an unmarked custom canvas is not evidence of a different theme.
    const actual = await new Promise(resolve => widget.save(resolve));
    change = actual.charts.some(chart => {
      const pane = chart.chartProperties?.paneProperties || {};
      const scales = chart.chartProperties?.scalesProperties || {};
      const background = String(pane.background).toLowerCase();
      const text = String(scales.textColor).toLowerCase();
      const light = ["#ffffff", "#fff"].includes(background) && text === "#0f0f0f";
      const dark = background === "#0f0f0f" && text === "#b8b8b8";
      return (theme === "Dark" && light) || (theme === "Light" && dark);
    });
  }
  if (change) await widget.changeTheme(theme, { disableUndo: true });
}
