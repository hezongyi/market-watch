from alerts.config import Settings


def test_settings_repr_omits_secrets_without_changing_runtime_values():
    private = {
        "database_url": "postgresql://test:example_password@localhost/test",
        "admin_password_hash": "example_admin_hash",
        "ntfy_token": "example_notification_token",
        "oanda_token": "example_provider_token",
        "oanda_account_id": "example_account_id",
    }
    config = Settings(_env_file=None, **private)
    rendered = repr(config)
    for key, value in private.items():
        assert value not in rendered
        assert getattr(config, key) == value
    assert "provider_interest_limit=16" in rendered
