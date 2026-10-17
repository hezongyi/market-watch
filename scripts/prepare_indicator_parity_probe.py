"""Prepare a synthetic native-renderer probe; never evidence of supplier prices.

Run with the task worktree's Python environment, then serve OUTPUT read-only in
the task's Ubuntu Docker network. This measures the real pinned native adapter
and coordinator against Python oracle outputs, independently of upstream health.
"""

import argparse
import json
import math
import shutil
from pathlib import Path

from alerts.chart_indicators import calculate, public_catalog


def result_key(name, params):
    # JSON numbers are parsed as JS Number: 3.0 and 3 have identical semantics.
    params = {key: int(value) if isinstance(value,float) and value.is_integer() else value
              for key,value in params.items()}
    return name + ':' + json.dumps(params,sort_keys=True,separators=(',',':'))


def prepare(output):
    root = Path(__file__).resolve().parents[1]
    output.mkdir(parents=True, exist_ok=True)
    end, step = 1790640000000, 86400000
    bars = []
    for index in range(1000):
        at = end - (1000 - index) * step
        value = 100 + math.sin(at / step) * 2
        bars.append(dict(start=at, end=at + step, chart_time=at, open=value,
                         high=value + 2, low=value - 2, close=value + 1, complete=True))
    catalog = public_catalog()
    results = {}
    for name in catalog:
        result = calculate(bars, {"name": name})
        results[result_key(name,result['params'])] = result
    for name, params in (("LWMA", {"period": 5}), ("LWMA", {"period": 6}), ("LWMA", {"period": 7}),
                         ("LWMA", {"period": 13}), ("EMA", {"period": 500}),
                         ("BBANDS", {"period": 21}), ("MACD", {"fast": 13}),
                         ("SUPERTREND_PINE_V1", {"period": 11})):
        result = calculate(bars, {"name": name, "params": params})
        results[result_key(name,result['params'])] = result
    (output / "oracle.js").write_text("window.parityData=" + json.dumps(
        dict(catalog=catalog, bars=bars, results=results), separators=(",", ":")) + ";\n")
    html = (root / "web/tests/fixtures/native-history.html").read_text()
    html = html.replace("<script>", """<script src="/oracle.js"></script>
<script src="/indicators.js"></script>
<script src="/native-indicator-results.js"></script>
<script src="/indicator-coordinator.js"></script><script>""", 1)
    html = html.replace("const widget=new TradingView.widget(",
        "MWNativeIndicatorResults.configure(parityData.catalog,{enable:true});const widget=new TradingView.widget(")
    html = html.replace("symbol:'TEST',interval:",
        "custom_indicators_getter:async PineJS=>pythonStudies(PineJS,parityData.catalog),symbol:'TEST',interval:")
    html = html.replace("</body>", "<script src='/parity-probe.js'></script></body>")
    (output / "index.html").write_text(html)
    for filename in ("indicators.js", "native-indicator-results.js", "indicator-coordinator.js"):
        shutil.copyfile(root / "advanced-host" / filename, output / filename)
    shutil.copyfile(root / "web/tests/fixtures/indicator-parity-probe.js", output / "parity-probe.js")
    library = output / "charting_library"
    if not library.exists():
        library.symlink_to(root / "advanced-host/charting_library", target_is_directory=True)
    print(json.dumps({"synthetic": True, "bars": len(bars), "catalog": list(catalog), "output": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    prepare(parser.parse_args().output.resolve())
