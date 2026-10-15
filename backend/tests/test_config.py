import pytest
from alerts.config import Settings
from pydantic import ValidationError


@pytest.mark.parametrize('raw,expected', [
    ('inherit', 'inherit'), ('on', 'on'), ('off', 'off'),
    ('true', 'on'), ('false', 'off'), ('YES', 'on'), ('0', 'off'),
])
def test_database_jit_environment_modes(monkeypatch, raw, expected):
    monkeypatch.setenv('ALERTS_DATABASE_JIT', raw)
    assert Settings(_env_file=None).database_jit == expected


def test_database_jit_inherits_by_default(monkeypatch):
    monkeypatch.delenv('ALERTS_DATABASE_JIT', raising=False)
    assert Settings(_env_file=None).database_jit == 'inherit'


@pytest.mark.parametrize('raw,expected', [(True, 'on'), (False, 'off')])
def test_database_jit_accepts_previous_boolean_values(raw, expected):
    assert Settings(_env_file=None, database_jit=raw).database_jit == expected


def test_database_jit_rejects_invalid_mode(monkeypatch):
    monkeypatch.setenv('ALERTS_DATABASE_JIT', 'automatic')
    with pytest.raises(ValidationError, match='database_jit'):
        Settings(_env_file=None)


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
