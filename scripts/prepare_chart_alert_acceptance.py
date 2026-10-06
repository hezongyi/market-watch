"""Create private local acceptance configuration; never touch production resources."""

import json
import os
import secrets
import subprocess

from argon2 import PasswordHasher
from chart_alert_acceptance_environment import APP, DATABASE, ROOT

os.umask(0o077)
root = ROOT
root.mkdir(mode=0o700, exist_ok=True)
os.chmod(root, 0o700)
(root / "tls.conf").write_text("""resolver 127.0.0.11 valid=5s ipv6=off;
upstream acceptance_web { zone acceptance_web 64k; server web:80 resolve; }
upstream acceptance_chart { zone acceptance_chart 64k; server chart-origin:80 resolve; }
server {
  listen 443 ssl;
  ssl_certificate /certs/cert.pem;
  ssl_certificate_key /certs/key.pem;
  location / { proxy_pass http://acceptance_web; proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https; proxy_buffering off; proxy_read_timeout 3600s; }
}
server {
  listen 444 ssl;
  ssl_certificate /certs/cert.pem;
  ssl_certificate_key /certs/key.pem;
  location / { proxy_pass http://acceptance_chart; }
}
""")
os.chmod(root / "tls.conf", 0o600)
existing = (root / "api.env").exists()
if not existing:
    password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    (root / "login.json").write_text(json.dumps({"password": password}))
    (root / "compose.env").write_text("MW_CHART_ALERTS_DB_PASSWORD=" + db_password + "\n")
    config = {
        "ALERTS_DATABASE_URL": f"postgresql+psycopg://{DATABASE}:{db_password}@pg/{DATABASE}",
        "ALERTS_DATABASE_APPLICATION_NAME": ROOT.name,
        "ALERTS_ADMIN_PASSWORD_HASH": PasswordHasher().hash(password),
        "ALERTS_COOKIE_SECURE": "true",
        "ALERTS_DELIVERY_ENABLED": "false",
        "ALERTS_PUBLIC_URL": APP,
        "ALERTS_INITIAL_HISTORY_DAYS": "0",
        "ALERTS_PROVIDER_REQUEST_SECONDS": "30",
    }
    (root / "api.env").write_text("".join(f"{key}={value}\n" for key, value in config.items()))
else:
    if not all((root / name).is_file() for name in ("login.json", "compose.env")):
        raise RuntimeError("Existing credentials are incomplete; restore the private configuration backup")
for name in ("api.env", "login.json", "compose.env"):
    os.chmod(root / name, 0o600)
certificate_ready = False
if (root / "cert.pem").is_file() and (root / "key.pem").is_file():
    checked = subprocess.run(["openssl", "x509", "-in", str(root / "cert.pem"),
                              "-checkend", "0", "-noout"], capture_output=True)
    if checked.returncode == 0:
        certificate = subprocess.run(["openssl", "x509", "-in", str(root / "cert.pem"),
                                      "-pubkey", "-noout"], capture_output=True, check=True)
        key = subprocess.run(["openssl", "pkey", "-in", str(root / "key.pem"),
                              "-pubout"], capture_output=True)
        certificate_ready = key.returncode == 0 and key.stdout == certificate.stdout
if not certificate_ready:
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
