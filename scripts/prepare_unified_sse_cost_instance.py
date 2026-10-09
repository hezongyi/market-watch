"""Create private credentials for one isolated old/new cost comparison."""

import argparse
import json
import os
import secrets
from pathlib import Path

from argon2 import PasswordHasher


def write_private(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write(content)


def env(values):
    return "".join(f"{key}='{value}'\n" for key, value in values.items())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--api-image", required=True)
    parser.add_argument("--web-image", required=True)
    parser.add_argument("--chart-image", required=True)
    parser.add_argument("--api-port", type=int, required=True)
    parser.add_argument("--web-port", type=int, required=True)
    parser.add_argument("--chart-port", type=int, required=True)
    parser.add_argument("--pg-port", type=int, required=True)
    args = parser.parse_args()
    if not args.task.isascii() or not all(c.islower() or c.isdigit() or c in "-_" for c in args.task):
        parser.error("task must be lowercase ASCII letters, digits, '-' or '_'")
    for port in (args.api_port, args.web_port, args.chart_port, args.pg_port):
        if not 1024 <= port <= 65535:
            parser.error("ports must be in 1024..65535")
    directory = args.directory.absolute()
    if directory.is_symlink():
        raise SystemExit("Refusing a symbolic-link configuration directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    if any(directory.iterdir()):
        raise SystemExit("Refusing to overwrite an existing private cost configuration")
    password, database = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    write_private(directory / "login.json", json.dumps({"password": password}) + "\n")
    write_private(directory / "acceptance.env", env({
        "ALERTS_DATABASE_URL": f"postgresql+psycopg://alerts:{database}@postgres/alerts",
        "ALERTS_DATABASE_APPLICATION_NAME": args.task,
        "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
        "ALERTS_COOKIE_SECURE": "false",
        "ALERTS_DELIVERY_ENABLED": "false",
        "ALERTS_PUBLIC_URL": f"http://127.0.0.1:{args.web_port}",
        "ALERTS_INITIAL_HISTORY_DAYS": "0",
        "ALERTS_YAHOO_ENABLED": "false",
    }))
    write_private(directory / "compose.env", env({
        "POSTGRES_PASSWORD": database,
        "MW_ACCEPTANCE_ENV": str(directory / "acceptance.env"),
        "MW_API_IMAGE": args.api_image,
        "MW_WEB_IMAGE": args.web_image,
        "MW_CHART_IMAGE": args.chart_image,
        "MW_API_PORT": str(args.api_port),
        "MW_WEB_PORT": str(args.web_port),
        "MW_CHART_PORT": str(args.chart_port),
        "MW_PG_PORT": str(args.pg_port),
    }))
    print(f"Prepared private cost credentials under {directory}; no Docker resources created")


if __name__ == "__main__":
    main()
