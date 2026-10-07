"""Prepare private credentials for one Ubuntu-only isolated Compose project."""

import json
import os
import secrets
import subprocess
from pathlib import Path

from argon2 import PasswordHasher

root = Path("/tmp/mw-chart-maximize-20261007")
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
if (root / "api.env").exists():
    raise SystemExit("Configuration already exists; preserve its credentials and database.")
password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
(root / "login.json").write_text(json.dumps({"password": password}))
(root / "compose.env").write_text(f"MAXIMIZE_DB_PASSWORD={db_password}\n")
config = {
    "ALERTS_DATABASE_URL": f"postgresql+psycopg://chart_maximize:{db_password}@pg/chart_maximize",
    "ALERTS_DATABASE_APPLICATION_NAME": "mw-chart-maximize-20261007",
    "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
    "ALERTS_COOKIE_SECURE": "true",
    "ALERTS_DELIVERY_ENABLED": "false",
    "ALERTS_MCP_ENABLED": "false",
    "ALERTS_YAHOO_ENABLED": "false",
    "ALERTS_PUBLIC_URL": "https://localhost:17443",
    "ALERTS_INITIAL_HISTORY_DAYS": "0",
}
(root / "api.env").write_text("".join(f"{k}={v}\n" for k, v in config.items()))
(root / "tls.conf").write_text("""server {
  listen 443 ssl;
  ssl_certificate /certs/cert.pem;
  ssl_certificate_key /certs/key.pem;
  location / { proxy_pass http://web:80; proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https; proxy_buffering off; proxy_read_timeout 3600s; }
}
server {
  listen 444 ssl;
  ssl_certificate /certs/cert.pem;
  ssl_certificate_key /certs/key.pem;
  location / { proxy_pass http://chart-origin:80; }
}
""")
subprocess.run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
     "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"), "-days", "30",
     "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    check=True, capture_output=True,
)
for file in root.iterdir():
    if file.is_file():
        os.chmod(file, 0o600)
print("Prepared private isolated configuration in " + str(root))
