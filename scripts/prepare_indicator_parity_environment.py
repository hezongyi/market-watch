"""Write private configuration for #74's Ubuntu Docker acceptance only."""

import json
import os
import secrets
import subprocess
from pathlib import Path

from argon2 import PasswordHasher

ROOT = Path('/tmp/mw-issue74-20261017')
PROJECT = 'mw-issue74-20261017'
REPO = Path(__file__).resolve().parents[1]
PG = 'postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872'


def prepare():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if not (ROOT / 'api.env').exists():
        password, db_password = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        (ROOT / 'credentials.json').write_text(json.dumps({'password': password}))
        (ROOT / 'database.json').write_text(json.dumps({'password': db_password}))
        config = {
            'ALERTS_DATABASE_URL': f'postgresql+psycopg://indicator_parity:{db_password}@pg/indicator_parity',
            'ALERTS_DATABASE_EXPECTED_VERSION': '140024',
            'ALERTS_DATABASE_APPLICATION_NAME': PROJECT,
            'ALERTS_DATABASE_POOL_SIZE': '3', 'ALERTS_DATABASE_MAX_OVERFLOW': '0',
            'ALERTS_ADMIN_PASSWORD_HASH': PasswordHasher().hash(password),
            'ALERTS_PUBLIC_URL': 'https://127.0.0.1:18474',
            'ALERTS_COOKIE_SECURE': 'true', 'ALERTS_DELIVERY_ENABLED': 'false',
            'ALERTS_YAHOO_ENABLED': 'false', 'ALERTS_MCP_ENABLED': 'false',
            'ALERTS_INITIAL_HISTORY_DAYS': '0',
            'ALERTS_OANDA_ACCOUNT_ID': 'indicator-parity-synthetic',
        }
        (ROOT / 'api.env').write_text(''.join(f'{key}={value}\n' for key, value in config.items()))
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes',
            '-keyout',str(ROOT/'key.pem'),'-out',str(ROOT/'cert.pem'),'-days','30',
            '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],
            check=True,capture_output=True)
    db_password = json.loads((ROOT / 'database.json').read_text())['password']
    labels = {'io.market-watch.task': PROJECT, 'io.market-watch.purpose': 'acceptance'}
    common = {'restart':'no', 'labels':labels, 'logging':{'options':{'max-size':'10m','max-file':'3'}}}
    application = {**common, 'image':'market-watch-api:issue74-baseline',
        'env_file':[{'path':str(ROOT/'api.env'),'format':'raw'}],
        'volumes':[f'{REPO}/scripts:/task-scripts:ro',f'{REPO}/backend/tests:/task-tests:ro'],
        'mem_limit':'768m','cpus':1.0}
    config = {'name':PROJECT, 'services':{
        'pg':{**common,'image':PG,'mem_limit':'384m','cpus':0.5,
            'environment':{'POSTGRES_DB':'indicator_parity','POSTGRES_USER':'indicator_parity','POSTGRES_PASSWORD':db_password},
            'volumes':['pg-data:/var/lib/postgresql/data'],
            'command':['postgres','-c','shared_buffers=64MB','-c','max_connections=40'],
            'healthcheck':{'test':['CMD-SHELL',"test \"$(PGOPTIONS='-c jit=on' psql -U indicator_parity -d indicator_parity -Atqc \"SELECT current_setting('server_version_num') = '140024' AND pg_jit_available()\")\" = t"],
                          'interval':'5s','timeout':'3s','retries':12}},
        'api':{**application,'depends_on':{'pg':{'condition':'service_healthy'}},
            'healthcheck':{'test':['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://localhost:8000/readyz',timeout=3)"],
                          'interval':'5s','timeout':'4s','retries':12}},
        'indicator-worker':{**application,'mem_limit':'512m',
            'command':['python','-m','alerts.history_versions'],
            'depends_on':{'api':{'condition':'service_healthy'}}},
        'web':{**common,'image':'market-watch-web:issue74-baseline','mem_limit':'96m','cpus':0.25,
            'depends_on':{'api':{'condition':'service_healthy'}}},
        'chart-origin':{**common,'image':'market-watch-chart-origin:issue74-baseline','mem_limit':'128m','cpus':0.5},
        'tls':{**common,'image':'nginx:1.28-alpine','mem_limit':'64m','cpus':0.25,
            'ports':['127.0.0.1:18474:443','127.0.0.1:17475:444'],
            'volumes':[f'{ROOT}/tls.conf:/etc/nginx/conf.d/default.conf:ro',
                       f'{ROOT}/cert.pem:/certs/cert.pem:ro',f'{ROOT}/key.pem:/certs/key.pem:ro'],
            'depends_on':['web','chart-origin']},
        'native-probe':{**common,'image':'nginx:1.28-alpine','mem_limit':'96m','cpus':0.5,
            'ports':['127.0.0.1:17474:80'],
            'volumes':[f'{ROOT}/native-probe:/usr/share/nginx/html:ro',
                       f'{REPO}/advanced-host/charting_library:/usr/share/nginx/html/charting_library:ro']},
    }, 'volumes':{'pg-data':{}}}
    (ROOT/'compose.json').write_text(json.dumps(config,indent=2)+'\n')
    (ROOT/'tls.conf').write_text('''server {
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
''')
    print(json.dumps({'project':PROJECT,'directory':str(ROOT),'synthetic':True,
                      'url':'https://127.0.0.1:18474/advanced-charts',
                      'application_memory_limit_mib':2048,'external_notifications':False}))


if __name__ == '__main__':
    prepare()
