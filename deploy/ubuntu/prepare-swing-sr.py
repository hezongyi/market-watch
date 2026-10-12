"""Prepare task-local acceptance secrets/TLS; no Docker or production operations."""

import json
import secrets
import subprocess
from pathlib import Path

from argon2 import PasswordHasher

PRIVATE = Path("/tmp/mw-swing-sr-20261012-private")
PRIVATE.mkdir(mode=0o700, exist_ok=True)
PRIVATE.chmod(0o700)
if (PRIVATE / "api.env").exists():
    raise SystemExit("Existing fixture preserved; use its files without regenerating passwords.")
password, postgres = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
files = {
    "api.env": "\n".join(
        [
            f"ALERTS_DATABASE_URL=postgresql+psycopg://swing:{postgres}@postgres/swing",
            "ALERTS_DATABASE_APPLICATION_NAME=mw-swing-sr-20261012",
            "ALERTS_COOKIE_SECURE=true",
            "ALERTS_PUBLIC_URL=https://localhost:16443",
            "ALERTS_FX_SOURCE=oanda",
            "ALERTS_DELIVERY_ENABLED=false",
            "ALERTS_INITIAL_HISTORY_DAYS=0",
            "ALERTS_ADMIN_PASSWORD_HASH=" + PasswordHasher().hash(password),
        ]
    )
    + "\n",
    "postgres.env": f"POSTGRES_DB=swing\nPOSTGRES_USER=swing\nPOSTGRES_PASSWORD={postgres}\n",
    "credentials.json": json.dumps({"password": password}),
}
tls = Path(__file__).parents[1] / "acceptance-tls.conf"
files["tls.conf"] = tls.read_text().replace(
    "location / { proxy_pass http://web:80;",
    "location / { proxy_buffering off; proxy_read_timeout 3600s; proxy_pass http://web:80;",
)
for name, content in files.items():
    path = PRIVATE / name
    path.write_text(content)
    path.chmod(0o600)
subprocess.run(
    [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        str(PRIVATE / "key.pem"),
        "-out",
        str(PRIVATE / "cert.pem"),
    ],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
(PRIVATE / "key.pem").chmod(0o600)
print(f"Prepared private acceptance fixture in {PRIVATE}; no service started.")
