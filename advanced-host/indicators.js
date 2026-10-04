/* Python computes every value; JS only maps backend series into the study API. */
function pythonStudies(PineJS, catalog) {
  return Object.entries(catalog).map(([name, meta]) => {
    const keys = Object.keys(meta.params),
      series = meta.series;
    const colors = ["#42a5f5", "#ffb74d", "#ab47bc"];
    return {
      name: "守望 Python " + name,
      metainfo: {
        _metainfoVersion: 53,
        id: "MWPython" + name + "@market-watch-1",
        description: "守望 Python " + name,
        shortDescription: "PY " + name,
        is_hidden_study: false,
        is_price_study: meta.pane === "main",
        isCustomIndicator: true,
        format: { type: "price", precision: 5 },
        plots: series.map((s, i) => ({ id: "plot" + i, type: "line" })),
        bands: (meta.levels || []).map((value, i) => ({
          id: "level" + i,
          name: String(value),
        })),
        defaults: {
          bands: (meta.levels || []).map((value) => ({
            color: "#787b86",
            linestyle: 2,
            linewidth: 1,
            value,
            visible: true,
          })),
          styles: Object.fromEntries(
            series.map((s, i) => [
              "plot" + i,
              {
                linestyle: 0,
                linewidth: 2,
                plottype: s.type === "histogram" ? 1 : 0,
                trackPrice: false,
                transparency: 0,
                visible: true,
                color: colors[i % colors.length],
              },
            ]),
          ),
          inputs: meta.params,
        },
        styles: Object.fromEntries(
          series.map((s, i) => [
            "plot" + i,
            { title: s.key, histogramBase: 0 },
          ]),
        ),
        inputs: keys.map((key) => {
          const rule =
            meta.parameter_schema?.[key] ||
            (key === "deviation"
              ? { type: "float", min: 0.1, max: 10 }
              : { type: "integer", min: 2, max: 500 });
          return {
            id: key,
            name: key,
            type: rule.type,
            defval: meta.params[key],
            min: rule.min,
            max: rule.max,
          };
        }),
      },
      constructor: function () {
        this.init = function (ctx, input) {
          const symbol = PineJS.Std.ticker(ctx).replace(/^Market Watch:/, "");
          const spec = {
            name,
            params: Object.fromEntries(keys.map((k, i) => [k, input(i)])),
          };
          for (const s of series)
            ctx.new_sym(
              "MWPY_" + btoa(JSON.stringify({ symbol, spec, key: s.key })),
              PineJS.Std.period(ctx),
            );
        };
        this.main = function (ctx) {
          ctx.select_sym(0);
          const target = ctx.new_var(PineJS.Std.time(ctx));
          const values = series.map((_, i) => {
            ctx.select_sym(i + 1);
            const source = ctx.new_var(PineJS.Std.time(ctx));
            const value = ctx.new_var(
              PineJS.Std.volume(ctx) > 0 ? PineJS.Std.close(ctx) : NaN,
            );
            return value.adopt(source, target, 1);
          });
          ctx.select_sym(0);
          return values;
        };
      },
    };
  });
}
