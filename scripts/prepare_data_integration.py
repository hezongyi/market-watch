"""Select only required source credentials for the isolated Ubuntu instance."""

import argparse
import json
import secrets
from pathlib import Path

from alerts.config import Settings
from argon2 import PasswordHasher


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-env", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1] / "artifacts/data-integration"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    files = [root / name for name in ("runtime.env", "compose.env", "login.json")]
    if any(path.exists() for path in files):
        raise SystemExit("Existing acceptance credentials retained; refusing to overwrite")
    settings = Settings(_env_file=args.source_env)
    if not settings.oanda_token or not settings.oanda_account_id:
        raise SystemExit("Configured practice token and account are required")
    password = secrets.token_urlsafe(24)
    values = {"ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
              "ALERTS_OANDA_STREAM_ENABLED": "true"}
    for field in ("oanda_token", "oanda_account_id", "oanda_proxy", "market_proxy"):
        value = getattr(settings, field)
        if "\n" in value or "\r" in value:
            raise SystemExit("Multiline source settings are unsupported")
        values["ALERTS_" + field.upper()] = value
    content = ["".join(f"{key}={value}\n" for key, value in values.items()),
               "MW_DATA_TEST_PASSWORD=" + secrets.token_hex(24) + "\n",
               json.dumps({"password": password})]
    for path, value in zip(files, content, strict=True):
        with path.open("x") as handle:
            path.chmod(0o600)
            handle.write(value)
    print("Isolated credentials ready in artifacts/data-integration (ignored; mode 0600)")


if __name__ == "__main__":
    main()
