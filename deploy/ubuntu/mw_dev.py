#!/usr/bin/env python3
"""Operate only the persistent mw-dev project; never delete its volume."""
import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STATE = Path.home() / '.local/share/market-watch-dev'
TASK = 'mw-dev-20261109'


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, cwd=REPO, **kwargs)


def compose(*args, **kwargs):
    files = ['-f', REPO / 'deploy/ubuntu/compose.development.yaml']
    if (STATE / 'source-mode').exists():
        files += ['-f', REPO / 'deploy/ubuntu/compose.development.source.yaml']
    if (STATE / 'frontend-mode').exists():
        files += ['-f', REPO / 'deploy/ubuntu/compose.development.frontend.yaml']
    return run(['docker', 'compose', '--env-file', STATE / 'compose.env', '-p', 'mw-dev', *files, *args], **kwargs)


def backup():
    directory = STATE / 'backups'
    directory.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = directory / f'dev-{stamp}.dump'
    temporary = target.with_suffix('.dump.tmp')
    with temporary.open('xb') as stream:
        compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'dev', '-d', 'dev', '-Fc', stdout=stream)
    if temporary.stat().st_size == 0:
        raise RuntimeError('Empty backup preserved for investigation')
    temporary.chmod(0o600)
    temporary.rename(target)
    audit = ("from alerts.storage import transaction, Audit\n"
             "with transaction() as db: db.add(Audit(kind='backup_completed', details={'target': 'Ubuntu mw-dev logical backup'}))")
    try:
        compose('exec', '-T', 'api', 'python', '-c', audit, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        print('Backup is complete; API audit could not be recorded', file=sys.stderr)
    print(target)
    return target


def build_web():
    run(['mw-docker', 'build', '--repo', REPO, '--context', '.', '--file', 'web/Dockerfile',
         '--component', 'web', '--tag', 'market-watch-web:dev-20261109', '--task', TASK,
         '--project', 'mw-dev', '--purpose', 'development', '--retain-days', '90'])
    compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', 'web')
    if (STATE / 'frontend-mode').exists():
        refresh_native_assets()


def refresh_native_assets():
    staged = STATE / 'web-dist'
    staged.mkdir(mode=0o700, exist_ok=True)
    compose('cp', 'web:/usr/share/nginx/html/.', staged)
    destination = STATE / 'native-assets'
    destination.mkdir(mode=0o700, exist_ok=True)
    for path in staged.iterdir():
        if path.name in {'index.html', 'assets'}:
            continue
        target = destination / path.name
        if path.is_dir():
            shutil.copytree(path, target, dirs_exist_ok=True)
        else:
            shutil.copy2(path, target)
    print('Native chart assets refreshed; reload the browser for native chart changes')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['up', 'stop', 'status', 'logs', 'restart', 'source-on',
                                          'source-off', 'frontend-on', 'frontend-off', 'web',
                                          'backup', 'migrate', 'credentials'])
    parser.add_argument('services', nargs='*')
    args = parser.parse_args()
    if not (STATE / 'compose.env').is_file():
        parser.error(f'Prepare private configuration in {STATE} first')
    allowed = {'api', 'market-runtime', 'data-worker', 'notification-worker', 'web', 'tls', 'postgres', 'ntfy', 'frontend'}
    if set(args.services) - allowed:
        parser.error('Unknown service')
    if args.command == 'up':
        compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
    elif args.command == 'stop':
        compose('stop', *args.services)
    elif args.command == 'status':
        compose('ps', '-a')
    elif args.command == 'logs':
        compose('logs', '--tail', '80', *args.services)
    elif args.command == 'restart':
        if not args.services:
            parser.error('Name the services to restart')
        compose('restart', *args.services)
    elif args.command in {'source-on', 'source-off'}:
        marker = STATE / 'source-mode'
        if args.command == 'source-on':
            marker.touch(mode=0o600)
        else:
            marker.unlink(missing_ok=True)
        compose('up', '-d', '--no-build', '--no-deps', '--force-recreate',
                '--wait', '--wait-timeout', '120',
                'api', 'market-runtime', 'data-worker', 'notification-worker')
    elif args.command == 'web':
        build_web()
    elif args.command == 'frontend-on':
        # Docker must find the nested mount point before mounting a read-only
        # checkout. Dependencies themselves live in the private writable bind.
        (REPO / 'web/node_modules').mkdir(exist_ok=True)
        refresh_native_assets()
        (STATE / 'frontend-mode').touch(mode=0o600)
        compose('up', '-d', '--no-build', 'frontend', 'web')
        compose('restart', 'tls')
    elif args.command == 'frontend-off':
        if (STATE / 'frontend-mode').exists():
            compose('stop', 'frontend')
        (STATE / 'frontend-mode').unlink(missing_ok=True)
        compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', 'web')
    elif args.command == 'backup':
        backup()
    elif args.command == 'migrate':
        backup()
        # Leave writers stopped if migration fails; do not hide incompatible schema.
        compose('stop', 'api', 'market-runtime', 'data-worker', 'notification-worker')
        compose('run', '--rm', '--no-deps', 'migrate')
        compose('up', '-d', '--no-build')
    elif args.command == 'credentials':
        print(f'Private login and notification subscription: {STATE / "credentials.json"}')
        print(f'Development CA certificate: {STATE / "tls/ca.pem"}')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
