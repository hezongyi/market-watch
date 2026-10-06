"""Create private local acceptance configuration; never touch production resources."""

import json
import os
import secrets
import subprocess
from pathlib import Path

from argon2 import PasswordHasher

root = Path("/tmp/mw-chart-alerts-acceptance")
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
if (root / "api.env").exists():
    raise SystemExit("Configuration exists; reuse it without resetting credentials.")
password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
(root / "login.json").write_text(json.dumps({"password": password}))
(root / "compose.env").write_text("MW_CHART_ALERTS_DB_PASSWORD=" + db_password + "\n")
config = {
    "ALERTS_DATABASE_URL": f"postgresql+psycopg://chart_alerts_acceptance:{db_password}@pg/chart_alerts_acceptance",
    "ALERTS_DATABASE_APPLICATION_NAME": "mw-chart-alerts-acceptance",
    "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
    "ALERTS_COOKIE_SECURE": "true",
    "ALERTS_DELIVERY_ENABLED": "false",
    "ALERTS_PUBLIC_URL": "https://localhost:19443",
    "ALERTS_INITIAL_HISTORY_DAYS": "0",
    "ALERTS_PROVIDER_REQUEST_SECONDS": "30",
}
(root / "api.env").write_text("".join(f"{key}={value}\n" for key, value in config.items()))
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
    [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(root / "key.pem"),
        "-out",
        str(root / "cert.pem"),
        "-days",
        "30",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    check=True,
    capture_output=True,
)
for file in root.iterdir():
    if file.is_file():
        os.chmod(file, 0o600)
print("Prepared private configuration in " + str(root))
