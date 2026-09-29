# Python 图表指标维护

## 计算路径

原生内置指标直接读取 Datafeed K 线，由图表库计算。Python 自定义指标由 `alerts.chart_indicators` 计算，通过 `advanced-host/indicators.js` 的合成品种适配显示。后者不是 Pine Script 编译器，也不自动接入预警规则。

## 当前最小新增步骤

1. 在后端增加一个 Python 模块，提供纯数组计算函数。
2. 使用 `alerts.chart_indicators.register(name, metadata, calculator)` 注册。注册必须在 API 开始服务前执行；目前没有插件目录自动扫描功能。可以在 `alerts.api` 导入区显式导入该注册模块。只重启图表历史 worker 不会更新 API 指标目录。
3. 添加数值回归，重启开发 API，刷新网页，在原生指标菜单选择“守望 Python 指标ID”。标准线/柱输出不需新增网页接线。
4. 修改指标参数并保存工作区，刷新确认恢复。先在开发库验证，再随正常版本升级发布。

示例：收盘价相对 SMA 的百分比偏离，避免零分母。

```python
import numpy as np
import talib
from alerts.chart_indicators import register


def deviation(high, low, close, params):
    average = talib.SMA(close, timeperiod=params["period"])
    values = np.full(len(close), np.nan)
    np.divide(close - average, average, out=values, where=average != 0)
    return {"value": values * 100}


register(
    "SMA_DEVIATION_V1",
    {"label": "均线偏离率", "pane": "sub", "params": {"period": 20}},
    deviation,
)
```

示例仅展示插件协议，并未默认加入用户指标菜单。名称改变算法语义时使用新ID，保留旧注册以便旧工作区继续加载；不要直接覆盖注册。

## 接口约束

- 输入依次为 high、low、close 的 NumPy 数组，以及验证后的参数字典。当前没有 open、volume、多品种或跨周期输入协议。
- 返回 `曲线key → 等长数值数组`；空输入也必须返回同样的曲线key和空数组，目录生成依赖此行为。
- 预热返回 NaN；后台将非有限值转换为 JSON null，显示适配以无值处理。真实0必须保留为0。
- 遇到不完整K线或交易数据缺口，框架分段调用算法，递归状态重新预热；不要在插件中填充未知行情。
- 计算必须只依赖当前及之前的数据，不能使用整个数组均值、向后移位等包含未来数据的操作来生成历史信号。
- 当前通用整数参数范围为2–500；`deviation`特例支持0.1–10浮点数。其他浮点、布尔或枚举参数需要同时扩展后端校验与前端参数元信息。
- `pane`为`main`或`sub`；多曲线由返回key决定，`styles: {"key": "histogram"}`可以声明柱形，其余默认线形。复杂填色、动态对象、标记需要新增适配。
- 当前原生Python入口使用ID作为名称、固定价格格式精度5；metadata里的中文label、levels及自定义格式尚未完整映射。不要把目录元信息存在等同于所有显示属性已支持。

## 验证与性能

后端先使用人工可核算的小数据验证正常值、预热、缺口、零分母与参数边界，再比较真实行情。浏览器用例 `web/tests/advanced-python-study.browser.cjs` 已覆盖SMA/MACD/STOCH/BBANDS的取数及参数恢复；它不证明任意新插件的数值正确。

Python指标目前计算历史数据的成本仍需优化。不要为提速直接截短EMA等递归指标的输入历史，避免改变数值。多图和多曲线共享相同在途历史规划请求，参数不同的指标仍独立计算。
