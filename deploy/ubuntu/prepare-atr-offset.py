"""Prepare private, task-local Ubuntu acceptance configuration without starting services."""

import json
import secrets
import subprocess
from pathlib import Path

from argon2 import PasswordHasher

PRIVATE = Path("/tmp/mw-atr-offset-20261012-private")
PRIVATE.mkdir(mode=0o700, exist_ok=True)
PRIVATE.chmod(0o700)
(PRIVATE / "evidence").mkdir(mode=0o777, exist_ok=True)
# Container uid 10001 owns writes within this bind; the private parent remains
# 0700 and credentials are never mounted into the sink.
(PRIVATE / "evidence").chmod(0o777)
if (PRIVATE / "api.env").exists():
    raise SystemExit("Existing private ATR fixture preserved; no credentials regenerated.")
password, postgres = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
url = f"postgresql+psycopg://atr:{postgres}@pg/atr"
files = {
    "api.env": "\n".join([
        f"ALERTS_DATABASE_URL={url}", "ALERTS_DATABASE_APPLICATION_NAME=mw-atr-offset-20261012",
        "ALERTS_COOKIE_SECURE=true", "ALERTS_PUBLIC_URL=https://localhost:17443",
        "ALERTS_FX_SOURCE=dukascopy", "ALERTS_DELIVERY_ENABLED=false",
        "ALERTS_NTFY_URL=http://notification-sink:8000", "ALERTS_NTFY_TOPIC=atr-offset-fixture",
        "ALERTS_YAHOO_ENABLED=false", "ALERTS_OANDA_STREAM_ENABLED=false",
        "ALERTS_INITIAL_HISTORY_DAYS=0", "ALERTS_ADMIN_PASSWORD_HASH=" + PasswordHasher().hash(password),
    ]) + "\n",
    "postgres.env": f"POSTGRES_DB=atr\nPOSTGRES_USER=atr\nPOSTGRES_PASSWORD={postgres}\n",
    "compose.env": f"MW_ATR_PRIVATE_DIR={PRIVATE}\nMW_ATR_TEST_POSTGRES_URL={url}\n",
    "credentials.json": json.dumps({"password": password}),
    "tls.conf": (Path(__file__).parents[1] / "acceptance-tls.conf").read_text(),
}
for name, contents in files.items():
    filename = PRIVATE / name
    filename.write_text(contents)
    filename.chmod(0o600)
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", str(PRIVATE / "key.pem"), "-out", str(PRIVATE / "cert.pem")],
    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(PRIVATE / "key.pem").chmod(0o600)
print(f"Prepared {PRIVATE}; no Docker operation or service startup performed.")
