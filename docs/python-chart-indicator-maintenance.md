# Python 图表指标维护

## 计算路径

原生内置指标直接读取 Datafeed K 线，由图表库计算。Python 自定义指标由 `alerts.chart_indicators` 计算，通过 `advanced-host/indicators.js` 的合成品种适配显示。后者不是 Pine Script 编译器，也不自动接入预警规则。

## 当前最小新增步骤

1. 在后端增加一个 Python 模块，提供纯数组计算函数。
2. 使用 `alerts.chart_indicators.register(name, metadata, calculator)` 注册。注册必须在 API 开始服务前执行；目前没有插件目录自动扫描功能。可以在 `alerts.api` 导入区显式导入该注册模块。只重启图表历史 worker 不会更新 API 指标目录。
3. 添加数值回归，重启开发 API，刷新网页，在“指标 → 我的 Python”按中文名称或 ID 搜索并添加。原生注册名仍为“守望 Python 指标ID”。标准线/柱输出不需新增网页接线。
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
    {
        "label": "均线偏离率", "pane": "sub", "params": {"period": 20},
        "parameter_schema": {
            "period": {"type": "integer", "min": 2, "max": 500, "default": 20}
        },
        "series": [{"key": "value", "type": "line"}],
        "history_requirement": lambda params: params["period"] - 1,
    },
    deviation,
)
```

示例仅展示插件协议，并未默认加入用户指标菜单。名称改变算法语义时使用新ID，保留旧注册以便旧工作区继续加载；不要直接覆盖注册。

## 接口约束

- 输入依次为 high、low、close 的 NumPy 数组，以及验证后的参数字典。当前没有 open、volume、多品种或跨周期输入协议。
- 显式声明有序 `series: [{key, type}]`（type 为 line 或 histogram）；返回同顺序的 `曲线key → 一维等长数值数组`。目录和空输入不执行算法。注册拒绝无效声明；运行时缺少、多余、乱序、非数值或错误长度的输出均报告指标 ID 与原因。
- 可选 `description` 和 `calculation` 为纯文本用途与计算说明，供窗口详情展示。公开目录仅输出声明字段；series 和 parameter_schema 的额外内部属性不会导出。
- 预热返回 NaN；后台将非有限值转换为 JSON null，显示适配以无值处理。真实0必须保留为0。
- 遇到不完整K线或交易数据缺口，框架分段调用算法，递归状态重新预热；不要在插件中填充未知行情。
- 输入数组只读，参数字典按次复制，计算不得修改输入。计算必须只依赖当前及之前的数据，不能使用整个数组均值、向后移位等包含未来数据的操作来生成历史信号。
- `parameter_schema` 必须与 params 同键，每项声明 integer/float、min、max、default。现有周期仍为2–500整数、deviation 为0.1–10浮点数；后端与原生设置均消费此声明。MACD保留 fast<slow 约束。不扩展布尔或枚举编辑器。
- `pane`为`main`或`sub`；多曲线顺序及 line/histogram 类型由 series 声明。复杂填色、动态对象、标记需要新增适配。
- 当前原生Python入口使用ID作为名称、固定价格格式精度5；metadata里的levels已映射为原生可配置参考线；中文label及自定义格式尚未完整映射。不要把目录元信息存在等同于所有显示属性已支持。

## 验证与性能

后端先使用人工可核算的小数据验证正常值、预热、缺口、零分母与参数边界，再比较真实行情。浏览器用例 `web/tests/advanced-python-study.browser.cjs` 已覆盖SMA/MACD/STOCH/BBANDS的取数及参数恢复；它不证明任意新插件的数值正确。

Python指标目前计算历史数据的成本仍需优化。不要为提速直接截短EMA等递归指标的输入历史，避免改变数值。多图和多曲线共享相同在途历史规划请求，参数不同的指标仍独立计算。

## 兼容与历史职责

- 算法 ID、原生 `MWPython<ID>@market-watch-1`、输入和输出顺序保持稳定。中文搜索展示名可改变，原生注册名不能随之改名。当前仅支持版本字符串 "1"；算法语义变化必须用新 ID 并保留旧注册。同 ID 多版本需要另行设计。
- 显式 `history_requirement(params)` 优先于内置规则和 period 推导，返回非负整数。目录不会序列化该 callable。8 个现有指标保留原预热数量。
- 行情编排负责闭合 K 线、gap_before、固定输入起点和结果裁剪；算法遇到未完成 K 线或缺口重新预热。固定倍数递归预热是近似，不承诺任意历史起点严格相同。分页比较必须使用同一输入起点；追加未来数据不得改变已确认历史。
- 未引入缓存、计算服务或新指标依赖。未来缓存设计必须先测量计算次数、长度和耗时。
