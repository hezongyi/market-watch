"""Prepare only this task's private browser config/assets and owned image.

Requires the already prepared P0 private env, Ubuntu Docker/mw-docker, existing
Node/nginx images, npm dependencies and locally permitted charting_library.
Never reads another instance's env or writes credentials/license files to git.
"""
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path

from argon2 import PasswordHasher
from run_suite import command,HERE

REPO=HERE.parents[2]
PRIVATE=Path('/tmp/mw-issue13-browser-private')
ASSETS=Path('/tmp/mw-issue13-browser-assets')
BUILD=Path('/tmp/mw-issue13-browser-build')


def main():
    if 'ID=ubuntu' not in Path('/etc/os-release').read_text().splitlines():
        raise SystemExit('Ubuntu local preparation only')
    os.umask(0o077)
    PRIVATE.mkdir(mode=0o700,exist_ok=True)
    env=PRIVATE/'compose.env'
    if not env.exists():
        password=secrets.token_urlsafe(24)
        (PRIVATE/'login.json').write_text(json.dumps(dict(password=password)))
        config=Path('/tmp/market-watch-issue13-local.env').read_text()
        for var,ref in [('ISSUE13_NGINX_IMAGE','nginx:1.28-alpine'),('ISSUE13_NODE_IMAGE','node:22-bookworm-slim')]:
            ident=subprocess.check_output(command(['docker','image','inspect',ref,'--format','{{.Id}}']),text=True).strip()
            config+='\n'+var+'='+ident
        config+="\nISSUE13_BROWSER_PASSWORD_HASH='"+PasswordHasher().hash(password)+"'\n"
        env.write_text(config)
    if not (PRIVATE/'login.json').exists():raise SystemExit('Existing private login incomplete; restore own credentials')
    for p in (env,PRIVATE/'login.json'):p.chmod(0o600)
    if not ASSETS.exists():
        library=Path(os.environ.get('CHARTING_LIBRARY_ROOT','/home/quant/repos/market-watch-chart-sync/advanced-host/charting_library'))
        if not (library/'charting_library.js').is_file():raise SystemExit('Locally permitted chart library missing')
        ASSETS.mkdir(mode=0o755)
        for p in (REPO/'advanced-host').iterdir():
            if p.is_file():shutil.copy2(p,ASSETS/p.name)
        shutil.copytree(library,ASSETS/'charting_library')
        subprocess.run(['node','patch-native-reserve.mjs'],cwd=ASSETS,check=True)
        subprocess.run(['node','build-assets.mjs'],cwd=ASSETS,check=True)
        # Build-generated files must be readable by the chart Nginx worker.
        for p in ASSETS.rglob('*'):p.chmod(0o755 if p.is_dir() else 0o644)
        ASSETS.chmod(0o755)
    if not (PRIVATE/'key.pem').exists():
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes',
            '-keyout',str(PRIVATE/'key.pem'),'-out',str(PRIVATE/'cert.pem'),'-days','30',
            '-subj','/CN=issue13-ubuntu','-addext','subjectAltName=IP:192.168.7.232'],
            check=True,capture_output=True)
    for source,target in [('web/nginx.conf','web-tls.conf'),('advanced-host/nginx.conf','chart-tls.conf')]:
        config=(REPO/source).read_text().replace('listen 80;',
            'listen 443 ssl;\n    ssl_certificate /certs/cert.pem;\n    ssl_certificate_key /certs/key.pem;')
        (PRIVATE/target).write_text(config)
    for p in PRIVATE.iterdir():
        if p.is_file():p.chmod(0o600)
    buildenv={**os.environ,'VITE_ADVANCED_CHART_ORIGIN':'https://192.168.7.232:19616'}
    subprocess.run(['npm','run','build','--prefix','web'],cwd=REPO,env=buildenv,check=True)
    # Credential umask must not make public frontend artifacts inaccessible to
    # Nginx's worker. Only the task-owned dist tree is made static-readable.
    (REPO/'web/dist').chmod(0o755)
    for p in (REPO/'web/dist').rglob('*'):p.chmod(0o755 if p.is_dir() else 0o644)
    if 'ISSUE13_BROWSER_IMAGE=' not in env.read_text():
        BUILD.mkdir(mode=0o700,exist_ok=True)
        shutil.copy2(HERE/'Browser.Dockerfile',BUILD/'Dockerfile')
        if not (BUILD/'node-rootfs.tar').exists():
            image=subprocess.check_output(command(['docker','image','inspect','node:22-bookworm-slim','--format','{{.Id}}']),text=True).strip()
            name='mw-issue13-browser-rootfs'
            subprocess.run(command(['docker','create','--name',name,'--label',
                'io.market-watch.task=issue13-browser-baseline','--entrypoint','/bin/true',image]),check=True)
            try:subprocess.run(command(['docker','export',name,'-o',str(BUILD/'node-rootfs.tar')]),check=True)
            finally:subprocess.run(command(['docker','rm',name]),check=True)
        subprocess.run(['mw-docker','build','--task','issue13-browser-baseline','--project','mw-issue13-p0',
            '--repo',str(REPO),'--purpose','acceptance','--component','web','--context',str(BUILD),
            '--file',str(BUILD/'Dockerfile'),'--tag','mw-issue13-browser:local'],check=True)
        image=subprocess.check_output(command(['docker','image','inspect','mw-issue13-browser:local','--format','{{.Id}}']),text=True).strip()
        with env.open('a') as out:out.write('ISSUE13_BROWSER_IMAGE='+image+'\n')
    print('Own browser preparation ready; private configuration retained, secrets not printed')


if __name__=='__main__':main()
