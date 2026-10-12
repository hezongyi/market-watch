/* Python computes every value; JS only maps backend series into the study API. */
function supertrendPineProfile() {
  // Direction colors sampled from the user's TradingView reference screenshot.
  const green = "#4caf50", red = "#ff5252";
  const lines = ["up", "down", "fill_reference", "up_fill", "down_fill"];
  const shapes = ["buy_dot", "sell_dot", "buy_label", "sell_label"];
  const titles = {
    up: "Up Trend", down: "Down Trend", fill_reference: "",
    up_fill: "Up fill boundary", down_fill: "Down fill boundary",
    buy_dot: "UpTrend Begins", sell_dot: "DownTrend Begins",
    buy_label: "Buy", sell_label: "Sell",
  };
  const plots = [...lines, ...shapes].map(id => ({id, type: lines.includes(id) ? "line" : "shapes"}));
  const styles = {}, defaults = {};
  for (const id of lines) {
    const reference = id === "fill_reference", hidden = id.endsWith("_fill");
    styles[id] = {title: titles[id], histogramBase: 0, isHidden: hidden};
    defaults[id] = {
      linestyle: 0, linewidth: reference ? 0 : 2, plottype: reference ? 3 : 7,
      trackPrice: false, transparency: reference || hidden ? 100 : 0,
      visible: true, display: hidden ? 0 : reference ? 10 : 15,
      color: id.startsWith("down") ? red : reference ? "#2196f3" : green,
    };
  }
  for (const id of shapes) {
    const buy = id.startsWith("buy"), label = id.endsWith("label");
    styles[id] = {title: titles[id], size: "tiny", text: label ? (buy ? "Buy" : "Sell") : ""};
    defaults[id] = {
      plottype: label ? (buy ? "shape_label_up" : "shape_label_down") : "shape_circle",
      // The installed runtime rejects AbsoluteUp/Down despite its d.ts enum.
      // Label shape orientation supplies the tip; the value is an absolute price.
      location: "Absolute",
      color: buy ? green : red, textColor: "#ffffff", transparency: 0,
      visible: true, display: 1,
    };
  }
  return {
    format: {type: "price", precision: 2}, plots, styles,
    filledAreas: [
      {id: "long_fill", objAId: "fill_reference", objBId: "up_fill", type: "plot_plot", title: "UpTrend Highlighter", fillgaps: false},
      {id: "short_fill", objAId: "fill_reference", objBId: "down_fill", type: "plot_plot", title: "DownTrend Highlighter", fillgaps: false},
    ],
    defaults: {styles: defaults, inputs: {
      period: 10, source: "hl2", multiplier: 3, changeATR: true, showsignals: true, highlighting: true,
    }, filledAreasStyle: {
      long_fill: {color: green, transparency: 90, visible: true},
      short_fill: {color: red, transparency: 90, visible: true},
    }},
    inputs: [
      {id: "period", name: "ATR Period", type: "integer", defval: 10, min: 1, max: 500},
      {id: "source", name: "Source", type: "text", defval: "hl2", options: ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"]},
      {id: "multiplier", name: "ATR Multiplier", type: "float", defval: 3, min: 0.1, max: 100, step: 0.1},
      {id: "changeATR", name: "Change ATR Calculation Method ?", type: "bool", defval: true},
      {id: "showsignals", name: "Show Buy/Sell Signals ?", type: "bool", defval: true},
      {id: "highlighting", name: "Highlighter On/Off ?", type: "bool", defval: true},
    ],
  };
}

function pythonStudies(PineJS, catalog) {
  return Object.entries(catalog).map(([name, meta]) => {
    const supertrend = meta.render_profile === "supertrend_pine_v1";
    const profile = supertrend ? supertrendPineProfile() : null;
    const keys = Object.keys(meta.params),
      series = supertrend ? meta.series.filter(s => s.key !== "direction") : meta.series;
    const swing = meta.render_profile === "swing_sr_v1";
    const displayInputs = Array.isArray(meta.display_inputs) ? meta.display_inputs : [];
    const colors = ["#42a5f5", "#ffb74d", "#ab47bc"];
    return {
      name: "守望 Python " + name,
      metainfo: {
        _metainfoVersion: 53,
        id: "MWPython" + name + "@market-watch-1",
        description: "守望 Python " + name,
        shortDescription: swing ? "Swing" : "PY " + name,
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
                plottype: swing ? 6 : s.type === "histogram" ? 1 : 0,
                ...(swing ? {joinPoints:false} : {}),
                trackPrice: false,
                transparency: 0,
                visible: true,
                color: swing ? (i < 2 ? "#f23645" : "#00bcd4") : colors[i % colors.length],
              },
            ]),
          ),
          inputs: {...meta.params, ...Object.fromEntries(displayInputs.map(item=>[item.id,item.default]))},
        },
        styles: Object.fromEntries(
          series.map((s, i) => [
            "plot" + i,
            { title: s.label || s.key, histogramBase: 0 },
          ]),
        ),
        inputs: [...keys.map((key) => {
          const rule =
            meta.parameter_schema?.[key] ||
            (key === "deviation"
              ? { type: "float", min: 0.1, max: 10 }
              : { type: "integer", min: 2, max: 500 });
          return {
            id: key,
            name: rule.label || (swing ? (key === "high_strength" ? "High strength" : "Low strength") : key),
            type: rule.type,
            defval: meta.params[key],
            min: rule.min,
            max: rule.max,
          };
        }), ...displayInputs.map(item=>({id:item.id,name:item.name,type:item.type,defval:item.default,
          ...(item.options ? {options:item.options} : {}),
          ...(swing && ['show_average_spacing','statistics_position'].includes(item.id)
            ? {isHidden:false,display:0} : {})}))],
        ...(profile || {}),
      },
      constructor: function () {
        this.init = function (ctx, input) {
          // Native tickerid may be an encoded window symbol. Keep our backend
          // identity plain and carry only the internal window on the study feed.
          const symbol = (ctx.symbol.info?.ticker || PineJS.Std.ticker(ctx)).replace(/^Market Watch:/, "");
          let window = ctx.symbol.info?.mw_window;
          if (!window && ctx.symbol.tickerid?.startsWith('=')) {
            try {
              let extended=JSON.parse(ctx.symbol.tickerid.slice(1));
              while(typeof extended.symbol !== 'string') extended=extended.symbol;
              window=extended['mw-window'];
            } catch { /* Keep ordinary symbol behavior for non-encoded tickers. */ }
          }
          const spec = {
            name,
            params: supertrend ? {
              period: input(0), source: input(1), multiplier: input(2),
              atr_method: input(3) ? "wilder" : "sma",
            } : Object.fromEntries(keys.map((k, i) => [k, input(i)])),
          };
          this.offsets = series.map(s=>s.key === 'high_left' ? -spec.params.high_strength :
            s.key === 'low_left' ? -spec.params.low_strength : 0);
          for (const s of series) {
            const ticker="MWPY_" + btoa(JSON.stringify({ symbol, spec, key: s.key }));
            ctx.new_sym(window ? '='+JSON.stringify({symbol:ticker,'mw-window':window}) : ticker,
              PineJS.Std.period(ctx));
          }
        };
        this.main = function (ctx, input) {
          ctx.select_sym(0);
          const target = ctx.new_var(PineJS.Std.time(ctx));
          const values = series.map((_, i) => {
            ctx.select_sym(i + 1);
            const source = ctx.new_var(PineJS.Std.time(ctx));
            const valid = PineJS.Std.volume(ctx);
            const gap = supertrend && valid === 2 && ["up", "down", "fill_reference"].includes(series[i].key);
            const value = ctx.new_var(
              valid > 0 && !gap ? PineJS.Std.close(ctx) : NaN,
            );
            const result = value.adopt(source, target, 1);
            return swing ? {value:result,offset:this.offsets[i]} : result;
          });
          ctx.select_sym(0);
          if (supertrend) {
            const [up, down, buy, sell, reference] = values;
            return [up, down, reference, input(5) ? up : NaN, input(5) ? down : NaN,
              buy, sell, input(4) ? buy : NaN, input(4) ? sell : NaN];
          }
          return values;
        };
      },
    };
  });
}
