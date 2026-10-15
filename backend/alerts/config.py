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
    # PostgreSQL 14.10 has a JIT inlining leak (fixed in 14.11). Keep JIT
    # disabled at connection time until all production servers are upgraded.
    database_jit: bool = False
    mcp_enabled: bool = False
    mcp_allowed_hosts: list[str] = ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "[::1]", "[::1]:*"]
    mcp_allowed_origins: list[str] = ["http://localhost", "http://localhost:*", "http://127.0.0.1", "http://127.0.0.1:*"]
    mcp_max_body_bytes: int = Field(default=65536, ge=1024, le=1048576)
    mcp_call_seconds: int = Field(default=20, ge=1, le=60)
    mcp_calls_per_minute: int = Field(default=60, ge=1, le=600)
    mcp_concurrency: int = Field(default=4, ge=1, le=16)
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
    binance_connection_mode: Literal["configured", "direct"] = "configured"
    yahoo_enabled: bool = False
    yahoo_proxy: str = Field(default="", repr=False)
    yahoo_poll_seconds: int = Field(default=60, ge=15, le=900)
    yahoo_metadata_ttl_seconds: int = Field(default=86400, ge=60, le=86400)
    yahoo_m1_span_days: int = Field(default=7, ge=1, le=8)
    yahoo_m1_retention_days: int = Field(default=30, ge=7, le=60)
    yahoo_minute_retention_days: int = Field(default=60, ge=1, le=60)
    yahoo_hour_retention_days: int = Field(default=730, ge=1, le=730)
    fx_source: Literal["dukascopy", "oanda"] = "dukascopy"
    oanda_token: str = Field(default="", repr=False)
    oanda_account_id: str = Field(default="", repr=False)
    oanda_proxy: str = ""
    oanda_stream_enabled: bool = False
    oanda_resident_symbols: str = "EUR_USD,XAU_USD"
    oanda_calendar_version: str = "ny17-candidate-v1"
    oanda_calendar_verified: bool = False
    oanda_calendar_profiles: dict[str, dict] = Field(default_factory=dict)
    # Status/scheduling evidence may be reviewed without reinterpreting an
    # immutable history calendar. Identity and finite applicability still apply.
    oanda_live_session_profiles: dict[str, dict] = Field(default_factory=dict)
    oanda_recovery_minutes: int = Field(default=1500, ge=120, le=20000)
    oanda_stream_lease_seconds: int = Field(default=30, ge=20, le=90)
    oanda_idle_grace_seconds: int = Field(default=60, ge=0, le=900)
    oanda_auth_probe_seconds: int = Field(default=300, ge=300, le=86400)
    oanda_maintenance_probe_seconds: int = Field(default=300, ge=60, le=3600)
    oanda_closed_probe_seconds: int = Field(default=900, ge=300, le=3600)
    session_hours: int = 24
    market_poll_seconds: int = 15
    coverage_projection_enabled: bool = True
    import_poll_seconds: int = 30
    history_health_workers: list[Literal["history_versions", "chart_history", "native_history", "legacy_import"]] = [
        "history_versions", "chart_history", "native_history",
    ]
    initial_history_days: int = Field(default=180, ge=0, le=366)
    postgres_bin_dir: str = ""
    provider_request_seconds: float = Field(default=8, ge=1, le=30)
    platform_native_update_diagnostics: bool = False
    provider_fresh_seconds: int = Field(default=15, ge=1, le=60)
    native_history_max_bars: int = Field(default=1000000, ge=20000, le=1000000)
    native_history_default_bars: int = Field(default=200000, ge=20000, le=1000000)
    native_history_workspace_bars: int = Field(default=4000000, ge=20000, le=8000000)
    native_history_response_bytes: int = Field(default=128 * 1024 * 1024, ge=1048576, le=268435456)
    native_history_task_seconds: int = Field(default=600, ge=30, le=1800)
    native_history_task_pages: int = Field(default=300, ge=8, le=2000)
    native_history_tasks_per_owner: int = Field(default=8, ge=1, le=16)
    provider_native_history_buffer: bool = True
    provider_native_cold_extra_bars: int = Field(default=400, ge=0, le=600)
    provider_native_first_extra_bars: int = Field(default=2000, ge=0, le=3000)
    provider_native_history_extra_bars: int = Field(default=2000, ge=0, le=2000)
    provider_basic_bars: int = Field(default=1000, ge=600, le=4000)
    provider_depth_bars: int = Field(default=4000, ge=1000, le=10000)
    provider_activity_seconds: int = Field(default=600, ge=30, le=3600)
    provider_subscription_seconds: int = Field(default=60, ge=30, le=300)
    provider_interest_limit: int = Field(default=16, ge=1, le=128)
    provider_cache_days: int = Field(default=7, ge=1, le=90)
    provider_cache_max_bars: int = Field(default=1000000, ge=40000, le=10000000)

    @property
    def effective_yahoo_proxy(self) -> str:
        return self.yahoo_proxy or self.market_proxy

    @property
    def effective_binance_proxy(self) -> str:
        if self.binance_connection_mode == "direct":
            return ""
        return self.binance_proxy or self.market_proxy


settings = Settings()
