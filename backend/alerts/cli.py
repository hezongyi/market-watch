"""Local administration. Credentials are entered interactively and never printed."""

import argparse
import getpass
from pathlib import Path

from argon2 import PasswordHasher


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init", "check"])
    parser.add_argument("--env", default=".env")
    args = parser.parse_args()
    if args.command == "init":
        path = Path(args.env)
        if path.exists():
            parser.error(
                "Environment file already exists; refusing to overwrite existing credentials"
            )
        password = getpass.getpass("管理员密码（至少 12 位）: ")
        if len(password) < 12:
            parser.error("Password must contain at least 12 characters")
        if getpass.getpass("再次输入: ") != password:
            parser.error("Passwords do not match")
        data = (
            f"ALERTS_ADMIN_PASSWORD_HASH='{PasswordHasher().hash(password)}'\n"
            "ALERTS_DATABASE_URL=sqlite:///./alerts.db\n"
            "ALERTS_PUBLIC_URL=http://localhost:8000\n"
            "ALERTS_COOKIE_SECURE=false\n"
            "ALERTS_DELIVERY_ENABLED=false\n"
            "ALERTS_NTFY_TOPIC=\n"
        )
        with path.open("x") as f:
            f.write(data)
        path.chmod(0o600)
        print(
            "初始化完成。仅本地 HTTP 使用非 Secure cookie；生产部署必须开启 HTTPS 和 Secure cookie。"
        )
    else:
        from .config import settings

        print(
            {
                "database": settings.database_url.split(":", 1)[0],
                "password_configured": bool(settings.admin_password_hash),
                "delivery_enabled": settings.delivery_enabled,
                "topic_configured": bool(settings.ntfy_topic),
                "cookie_secure": settings.cookie_secure,
            }
        )


if __name__ == "__main__":
    main()
