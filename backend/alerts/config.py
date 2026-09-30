from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ALERTS_", env_file=".env", extra="ignore")
    database_url: str = "sqlite:///./alerts.db"
    database_pool_size: int = Field(default=2, ge=1, le=20)
    database_max_overflow: int = Field(default=0, ge=0, le=20)
    database_pool_timeout: int = Field(default=15, ge=1, le=120)
    database_application_name: str = "market-watch"
    public_url: str = "http://localhost:8000"
    admin_password_hash: str = ""
    cookie_secure: bool = True
    ntfy_url: str = "https://ntfy.sh"
    ntfy_topic: str = ""
    ntfy_token: str = ""
    # Network delivery is deliberately explicit. Default local runs cannot ring a phone.
    delivery_enabled: bool = False
    adapter_path: str = "adapters/dukascopy/probe.mjs"
    market_proxy: str = ""
    binance_proxy: str = ""
    fx_source: Literal["dukascopy", "oanda"] = "dukascopy"
    oanda_token: str = ""
    oanda_account_id: str = ""
    oanda_proxy: str = ""
    session_hours: int = 24
    market_poll_seconds: int = 15
    import_poll_seconds: int = 30
    initial_history_days: int = Field(default=180, ge=0, le=366)
    postgres_bin_dir: str = ""


settings = Settings()
