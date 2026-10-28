"""Local administration. Credentials are entered interactively and never printed."""

import argparse
import getpass
import json
from pathlib import Path

from argon2 import PasswordHasher


def _retention(args):
    """One bounded cleanup step, or the restore drill that gates real deletion."""
    from . import retention_window

    options = {name: getattr(args, name) for name in ("limit", "chunk", "budget_ms")
               if getattr(args, name) is not None}
    if args.restore_drill:
        record = retention_window.restore_drill(Path(args.restore_drill))
    elif args.status:
        record = {"marker": retention_window.restore_marker(),
                  "deletion_order": list(retention_window.DELETION_ORDER),
                  "window_hours": retention_window.WINDOW_HOURS}
    elif args.execute:
        record = retention_window.execute(args.run_id, **options)
    else:
        record = retention_window.dry_run(args.run_id, **options)
    print(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True, default=str))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init", "check", "retention"])
    parser.add_argument("--env", default=".env")
    parser.add_argument("--run-id", help="切换运行 ID；省略时使用最近的 succeeded 运行")
    parser.add_argument("--limit", type=int, help="单批候选分钟上限")
    parser.add_argument("--chunk", type=int, help="每个事务提交的行数上限")
    parser.add_argument("--budget-ms", type=int, help="单次调用的时间预算（毫秒）")
    parser.add_argument("--dry-run", action="store_true", help="只报告，绝不删除")
    parser.add_argument("--execute", action="store_true", help="执行真实删除")
    parser.add_argument("--status", action="store_true", help="查看恢复演练标记与清理顺序")
    parser.add_argument("--restore-drill", metavar="DIRECTORY",
                        help="执行一次备份与真实恢复校验并记录标记")
    args = parser.parse_args()
    if args.command == "init":
        path = Path(args.env)
        if path.exists():
            parser.error(
                "Environment file already exists; refusing to overwrite existing credentials"
            )
        password = getpass.getpass("管理员密码（至少 6 位）: ")
        if len(password) < 6:
            parser.error("Password must contain at least 6 characters")
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
    elif args.command == "retention":
        _retention(args)
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
