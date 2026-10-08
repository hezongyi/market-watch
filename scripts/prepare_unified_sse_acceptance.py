"""Prepare task-private Ubuntu configuration without connecting to Docker."""

import argparse
import json
import os
import secrets
from pathlib import Path

from argon2 import PasswordHasher

TASK = "mw-unified-sse-20261008"


def private_write(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(content)


def env_text(values):
    # Compose interpolates unquoted dollar signs, including Argon2 hashes.
    # Single-quoted dotenv values preserve the exact authentication credential.
    return "".join(f"{key}='{value}'\n" for key, value in values.items())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    directory = args.directory or repo / "artifacts" / "unified-sse"
    directory = directory.absolute()
    if directory.is_symlink():
        raise SystemExit("Refusing a symbolic-link configuration directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise SystemExit("Configuration directory is not empty; preserving existing credentials")
    os.chmod(directory, 0o700)
    password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    database_url = f"postgresql+psycopg://alerts:{db_password}@postgres/alerts"
    private_write(directory / "login.json", json.dumps({"password": password}) + "\n")
    api = {
        "ALERTS_DATABASE_URL": database_url,
        "ALERTS_DATABASE_APPLICATION_NAME": TASK,
        "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
        "ALERTS_COOKIE_SECURE": "false",
        "ALERTS_DELIVERY_ENABLED": "false",
        "ALERTS_PUBLIC_URL": "http://127.0.0.1:15643",
        "ALERTS_INITIAL_HISTORY_DAYS": "0",
        "ALERTS_YAHOO_ENABLED": "false",
    }
    private_write(directory / "acceptance.env", env_text(api))
    compose = {
        "POSTGRES_PASSWORD": db_password,
        "MW_ACCEPTANCE_ENV": str(directory / "acceptance.env"),
        "MW_API_IMAGE": "market-watch-api:unified-sse-20261008",
        "MW_WEB_IMAGE": "market-watch-web:unified-sse-20261008",
        "MW_CHART_IMAGE": "market-watch-chart-origin:unified-sse-20261008",
    }
    private_write(directory / "compose.env", env_text(compose))
    private_write(directory / "tests.env",
        f"TEST_POSTGRES_URL=postgresql+psycopg://alerts:{db_password}@127.0.0.1:15645/alerts\n")
    print(f"Prepared private configuration at {directory}; no images or instances were created")


if __name__ == "__main__":
    main()
