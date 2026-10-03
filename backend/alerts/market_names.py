"""Local Chinese names for catalog search; supplier codes remain unchanged."""

from .yahoo_aliases import ALIASES

_CURRENCIES = {
    "USD": "美元", "EUR": "欧元", "GBP": "英镑", "JPY": "日元",
    "CHF": "瑞郎", "AUD": "澳元", "NZD": "新西兰元", "CAD": "加元",
    "CNH": "离岸人民币", "CNY": "人民币", "HKD": "港元", "SGD": "新加坡元",
    "NOK": "挪威克朗", "SEK": "瑞典克朗", "DKK": "丹麦克朗", "ZAR": "南非兰特",
    "TRY": "土耳其里拉", "MXN": "墨西哥比索", "PLN": "波兰兹罗提",
    "XAU": "黄金", "XAG": "白银",
}
_OANDA = {
    "SPX500_USD": "标普 500 指数", "NAS100_USD": "纳斯达克 100 指数",
    "US30_USD": "道琼斯工业平均指数", "UK100_GBP": "英国富时 100 指数",
    "DE30_EUR": "德国 DAX 指数", "JP225_USD": "日经 225 指数",
    "HK33_HKD": "香港恒生指数", "AU200_AUD": "澳大利亚 200 指数",
    "EU50_EUR": "欧洲斯托克 50 指数", "FR40_EUR": "法国 CAC 40 指数",
    "WTICO_USD": "WTI 原油", "BCO_USD": "布伦特原油", "NATGAS_USD": "天然气",
    "XCU_USD": "铜 / 美元",
}
_CRYPTO = {
    "BTC": "比特币", "ETH": "以太坊", "SOL": "索拉纳", "BNB": "币安币",
    "XRP": "瑞波币", "DOGE": "狗狗币", "LTC": "莱特币", "ADA": "艾达币",
}


def chinese_name(source, symbol):
    code = symbol.upper()
    if source == "yahoo":
        return ALIASES.get(code, (None,))[0]
    if source == "oanda":
        if code in _OANDA:
            return _OANDA[code]
        pair = code.split("_")
        if len(pair) == 2 and all(part in _CURRENCIES for part in pair):
            return " / ".join(_CURRENCIES[part] for part in pair)
    if source == "binance":
        for quote in ("USDT", "USDC", "USD", "BTC", "ETH"):
            base = code.removesuffix(quote)
            if base != code and base in _CRYPTO:
                return _CRYPTO[base] + " / " + _CRYPTO.get(quote, _CURRENCIES.get(quote, quote))
    return None
