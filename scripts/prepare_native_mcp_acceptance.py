"""Create private Ubuntu acceptance configuration. Never reuse production data."""

import json
import os
import secrets
import subprocess
from pathlib import Path

import certifi
from argon2 import PasswordHasher

root = Path("/tmp/mw-native-mcp-acceptance")
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
if (root / "api.env").exists():
    raise SystemExit("Configuration exists; reuse it without resetting credentials.")
password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
(root / "login.json").write_text(json.dumps({"password": password}))
(root / "compose.env").write_text("MW_MCP_DB_PASSWORD=" + db_password + "\n")
config = {
    "ALERTS_DATABASE_URL": f"postgresql+psycopg://native_mcp_acceptance:{db_password}@pg/native_mcp_acceptance",
    "ALERTS_DATABASE_APPLICATION_NAME": "mw-native-mcp-acceptance",
    "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
    "ALERTS_COOKIE_SECURE": "true",
    "ALERTS_DELIVERY_ENABLED": "false",
    "ALERTS_PUBLIC_URL": "https://localhost:18543",
    "ALERTS_INITIAL_HISTORY_DAYS": "0",
    "ALERTS_MCP_ENABLED": "true",
    "ALERTS_MCP_ALLOWED_HOSTS": json.dumps(
        ["localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "api:8000"]
    ),
    "ALERTS_MCP_ALLOWED_ORIGINS": json.dumps(
        ["https://localhost:18543", "https://127.0.0.1:18543"]
    ),
    "ALERTS_PROVIDER_REQUEST_SECONDS": "15",
    "ALERTS_MCP_CALLS_PER_MINUTE": "300",
}
(root / "api.env").write_text("".join(f"{key}={value}\n" for key, value in config.items()))
(root / "tls.conf").write_text("""server {
  listen 443 ssl;
  ssl_certificate /certs/cert.pem;
  ssl_certificate_key /certs/key.pem;
  location / { proxy_pass http://web:80; proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https; proxy_buffering off; proxy_read_timeout 65s; }
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
        "7",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    check=True,
    capture_output=True,
)
(root / "ca-bundle.pem").write_text(
    Path(certifi.where()).read_text() + (root / "cert.pem").read_text()
)
for file in root.iterdir():
    os.chmod(file, 0o600)
print("Private configuration prepared:", root)
