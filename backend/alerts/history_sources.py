"""One bounded history interface over the two supported managed M1 adapters."""

import hashlib

from .config import settings
from .market_contracts import DatasetIdentity
from .source_registry import collection_identity


class HistoryConfigurationError(ValueError):
    """Permanent configuration error, safe to report without supplier bodies."""


def history_identity(raw):
    identity = DatasetIdentity.model_validate(raw)
    collection_identity(identity)
    if identity.source not in ("dukascopy", "oanda", "fxcm"):
        raise ValueError("此来源尚未支持自建历史版本")
    if identity.source == "dukascopy" and identity.account_scope != "public":
        raise ValueError("Dukascopy公共历史必须使用public账户范围")
    return identity


def page_end(identity, start, end):
    """Bound a request before entering the adapter, independent of calendar phase."""
    identity = history_identity(identity)
    minutes = 300 if identity.source == "fxcm" else 4000 if identity.source == "oanda" else 31 * 1440
    return min(end, start + minutes * 60000)


class HistorySources:
    def __init__(self, *, adapters=None):
        self.adapters = dict(adapters or {})
        self.owned = set()

    def page(self, identity, start, end):
        identity = history_identity(identity)
        source = identity.source
        if source == "oanda":
            scope = "sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
            if not settings.oanda_token or not settings.oanda_account_id or identity.account_scope != scope:
                if source not in self.adapters:
                    raise HistoryConfigurationError("oanda_history_configuration")
        if source == "fxcm" and source not in self.adapters:
            from .fxcm_history import account_scope, configured
            if not configured() or identity.account_scope != account_scope():
                raise HistoryConfigurationError("fxcm_history_configuration")
        if source not in self.adapters:
            if source == "fxcm":
                from .fxcm_history import FxcmHistory
                self.adapters[source] = FxcmHistory()
            elif source == "dukascopy":
                from .dukascopy_history import DukascopyHistory

                self.adapters[source] = DukascopyHistory(proxy=settings.market_proxy)
            else:
                from .oanda_stream import OandaPractice

                self.adapters[source] = OandaPractice(token=settings.oanda_token,
                    account_id=settings.oanda_account_id, proxy=settings.oanda_proxy)
            self.owned.add(source)
        return self.adapters[source].page(identity, start, end)

    def native_page(self, identity, start, end):
        from .market_contracts import SourceIdentity

        identity = SourceIdentity.model_validate(identity)
        if identity.source == "yahoo":
            from .provider_yahoo import archive_page

            if "yahoo" in self.adapters:
                return self.adapters["yahoo"].native_page(identity, start, end)
            return archive_page(identity, start, end)
        if identity.source == "akshare":
            if "akshare" not in self.adapters:
                from .provider_akshare import AKShareHistory

                self.adapters["akshare"] = AKShareHistory()
                self.owned.add("akshare")
            return self.adapters["akshare"].native_page(identity, start, end)
        raise HistoryConfigurationError("native_history_configuration")

    def close(self):
        for source in self.owned:
            self.adapters[source].close()
        self.owned.clear()
