from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ALERTS_", env_file=".env", extra="ignore")
    database_url: str = Field(default="sqlite:///./alerts.db", repr=False)
    database_pool_size: int = Field(default=2, ge=1, le=20)
    database_max_overflow: int = Field(default=0, ge=0, le=20)
    database_pool_timeout: int = Field(default=15, ge=1, le=120)
    database_application_name: str = "market-watch"
    public_url: str = "http://localhost:8000"
    admin_password_hash: str = Field(default="", repr=False)
    cookie_secure: bool = True
    ntfy_url: str = "https://ntfy.sh"
    ntfy_topic: str = ""
    ntfy_token: str = Field(default="", repr=False)
    # Network delivery is deliberately explicit. Default local runs cannot ring a phone.
    delivery_enabled: bool = False
    adapter_path: str = "adapters/dukascopy/probe.mjs"
    market_proxy: str = ""
    binance_proxy: str = ""
    fx_source: Literal["dukascopy", "oanda"] = "dukascopy"
    oanda_token: str = Field(default="", repr=False)
    oanda_account_id: str = Field(default="", repr=False)
    oanda_proxy: str = ""
    session_hours: int = 24
    market_poll_seconds: int = 15
    import_poll_seconds: int = 30
    initial_history_days: int = Field(default=180, ge=0, le=366)
    postgres_bin_dir: str = ""
    provider_request_seconds: float = Field(default=8, ge=1, le=30)
    provider_fresh_seconds: int = Field(default=15, ge=1, le=60)
    provider_basic_bars: int = Field(default=1000, ge=600, le=4000)
    provider_depth_bars: int = Field(default=4000, ge=1000, le=10000)
    provider_activity_seconds: int = Field(default=600, ge=30, le=3600)
    provider_subscription_seconds: int = Field(default=60, ge=30, le=300)
    provider_interest_limit: int = Field(default=16, ge=1, le=128)
    provider_cache_days: int = Field(default=7, ge=1, le=90)
    provider_cache_max_bars: int = Field(default=1000000, ge=40000, le=10000000)

    @property
    def effective_binance_proxy(self) -> str:
        return self.binance_proxy or self.market_proxy


settings = Settings()
