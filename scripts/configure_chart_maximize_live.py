"""Configure real chart sources only in this task's independent Ubuntu database."""

from alerts.config import settings
from alerts.storage import AdvancedWorkspace, Bar, Instrument, Preference, transaction
from sqlalchemy import func, select
from sqlalchemy.engine import make_url

url = make_url(settings.database_url)
if (
    settings.database_application_name != "mw-chart-maximize-20261007"
    or url.host != "pg"
    or url.database != "chart_maximize"
    or url.username != "chart_maximize"
    or settings.delivery_enabled
    or settings.fx_source != "oanda"
    or not settings.oanda_token
    or not settings.oanda_account_id
):
    raise SystemExit("Refusing incomplete configuration or a database outside this Ubuntu task")

marker = "acceptance.chart-maximize.live-v1121"
with transaction() as db:
    if db.get(Preference, marker):
        print("Existing real-market workspace and user settings preserved")
    else:
        for ident, symbol in (("EURUSD", "EUR_USD"), ("XAUUSD", "XAU_USD")):
            instrument = db.get(Instrument, ident)
            if instrument is None:
                raise SystemExit("Expected bootstrap instrument missing")
            if instrument.source != "oanda" and db.scalar(
                select(func.count()).select_from(Bar).where(Bar.instrument_id == ident)
            ):
                raise SystemExit("Refusing to change the source of existing market observations")
            instrument.source = "oanda"
            instrument.symbol = symbol
            instrument.basis = "bid"
        ident = "chart-maximize-live"
        if not db.get(AdvancedWorkspace, ident):
            db.add(AdvancedWorkspace(
                id=ident,
                name="双击放大验收 · 真实行情",
                document={"engine": "tv31", "schemaVersion": 1,
                          "symbol": "MWP:XAUUSD", "series_kind": "provider", "interval": "60"},
            ))
        db.add(Preference(key=marker, value={"real_market": True, "baseline": "9670dae"}))
        print("Configured independent real-market workspace; synthetic workspace preserved")
