"""Actual connection settings, including rollback, in a task-owned PostgreSQL."""

import os

import pytest
from alerts import storage
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

pytestmark = pytest.mark.skipif(not os.getenv('TEST_POSTGRES_URL'),
                               reason='Requires isolated Ubuntu PostgreSQL')


@pytest.mark.parametrize('mode', ['inherit', 'on', 'off'])
def test_jit_preserves_url_options_and_survives_pool_rollback(monkeypatch, mode):
    url = make_url(os.environ['TEST_POSTGRES_URL']).update_query_dict({
        'options': '-c search_path=pg_catalog -c statement_timeout=3210 -c jit=off',
    }).render_as_string(hide_password=False)
    monkeypatch.setattr(storage.settings, 'database_jit', mode)
    engine = storage.make_engine(url)
    try:
        for _ in range(2):
            with engine.connect() as connection:
                assert connection.scalar(text('SHOW jit')) == ('on' if mode == 'on' else 'off')
                assert connection.scalar(text('SHOW search_path')) == 'pg_catalog'
                assert connection.scalar(text('SHOW statement_timeout')) == '3210ms'
                assert connection.scalar(text('SHOW application_name')) == storage.settings.database_application_name
                connection.rollback()
    finally:
        engine.dispose()


@pytest.mark.parametrize('mode', ['inherit', 'on', 'off'])
def test_inherit_uses_database_default_without_url_options(monkeypatch, mode):
    url = os.environ['TEST_POSTGRES_URL']
    admin = create_engine(url)
    with admin.connect() as connection:
        database_default = connection.scalar(text('SHOW jit'))
    admin.dispose()
    monkeypatch.setattr(storage.settings, 'database_jit', mode)
    engine = storage.make_engine(url)
    try:
        with engine.connect() as connection:
            assert connection.scalar(text('SHOW jit')) == (database_default if mode == 'inherit' else mode)
    finally:
        engine.dispose()


@pytest.mark.parametrize('mode', ['inherit', 'on', 'off'])
def test_jit_override_preserves_pgoptions_environment(monkeypatch, mode):
    monkeypatch.setenv('PGOPTIONS', '-c search_path=pg_catalog -c statement_timeout=4321 -c jit=off')
    monkeypatch.setattr(storage.settings, 'database_jit', mode)
    url = make_url(os.environ['TEST_POSTGRES_URL']).difference_update_query(['options'])
    engine = storage.make_engine(url.render_as_string(hide_password=False))
    try:
        with engine.connect() as connection:
            assert connection.scalar(text('SHOW jit')) == ('on' if mode == 'on' else 'off')
            assert connection.scalar(text('SHOW search_path')) == 'pg_catalog'
            assert connection.scalar(text('SHOW statement_timeout')) == '4321ms'
    finally:
        engine.dispose()


def test_acceptance_version_gate_rejects_wrong_server(monkeypatch):
    monkeypatch.setattr(storage.settings, 'database_expected_version', 170000, raising=False)
    engine = storage.make_engine(os.environ['TEST_POSTGRES_URL'])
    try:
        with pytest.raises(RuntimeError, match='PostgreSQL version mismatch'):
            engine.connect()
    finally:
        engine.dispose()


def test_acceptance_version_gate_reports_actual_connection(monkeypatch):
    monkeypatch.setattr(storage.settings, 'database_expected_version', 140024, raising=False)
    monkeypatch.setattr(storage.settings, 'database_jit', 'on')
    engine = storage.make_engine(os.environ['TEST_POSTGRES_URL'])
    try:
        with engine.connect() as connection:
            version, available, mode = connection.execute(text('''SELECT
                current_setting('server_version_num')::int,pg_jit_available(),current_setting('jit')''')).one()
            assert (version, available, mode) == (140024, True, 'on')
    finally:
        engine.dispose()


@pytest.mark.parametrize('mode', ['inherit', 'off'])
def test_acceptance_probe_restores_disabled_policy(monkeypatch, mode):
    url = make_url(os.environ['TEST_POSTGRES_URL']).update_query_dict({
        'options': '-c jit=off',
    }).render_as_string(hide_password=False)
    monkeypatch.setattr(storage.settings, 'database_expected_version', 140024)
    monkeypatch.setattr(storage.settings, 'database_jit', mode)
    engine = storage.make_engine(url)
    try:
        with engine.connect() as connection:
            assert connection.scalar(text('SHOW jit')) == 'off'
    finally:
        engine.dispose()
