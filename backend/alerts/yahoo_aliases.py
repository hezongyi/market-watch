"""Small local names; market metadata is fetched separately from Yahoo."""

ALIASES = {
    "GC=F": ("黄金期货 · COMEX", "FUTURE"),
    "CL=F": ("WTI 原油期货 · NYMEX", "FUTURE"),
    "SI=F": ("白银期货 · COMEX", "FUTURE"),
    "^GSPC": ("标普 500 指数", "INDEX"),
    "^DJI": ("道琼斯工业平均指数", "INDEX"),
    "^IXIC": ("纳斯达克综合指数", "INDEX"),
    "SPY": ("SPDR 标普 500 ETF", "ETF"),
    "QQQ": ("Invesco 纳斯达克 100 ETF", "ETF"),
    "AAPL": ("苹果公司", "EQUITY"),
    "MSFT": ("微软公司", "EQUITY"),
    "NVDA": ("英伟达", "EQUITY"),
    "TSLA": ("特斯拉", "EQUITY"),
    "AMZN": ("亚马逊", "EQUITY"),
    "GOOGL": ("谷歌", "EQUITY"),
    "META": ("Meta 平台公司", "EQUITY"),
    "EURUSD=X": ("欧元／美元", "CURRENCY"),
    "GBPUSD=X": ("英镑／美元", "CURRENCY"),
}
