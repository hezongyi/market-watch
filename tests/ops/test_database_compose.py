"""Render maintained Compose entry points without loading private service env files."""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINNED_PG = 'postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872'


@unittest.skipUnless(shutil.which('docker'), 'Requires Docker Compose CLI')
class DatabaseComposeTests(unittest.TestCase):
    def render(self, paths, **overrides):
        variables = set()
        for path in paths:
            variables.update(re.findall(r'\$\{([A-Z][A-Z0-9_]*)', (ROOT / path).read_text()))
        environment = os.environ.copy()
        for name in set(environment) | variables:
            if name.endswith('DATABASE_JIT'):
                environment.pop(name, None)
        with tempfile.TemporaryDirectory(prefix='mw-compose-policy-') as directory:
            fixture = Path(directory) / 'fixture.env'
            values = {}
            for name in variables:
                if name.endswith('DATABASE_JIT'):
                    continue
                if name.endswith('IMAGE'):
                    component = 'web' if 'WEB' in name else 'chart-origin' if 'CHART' in name else 'backup' if 'BACKUP' in name else 'api'
                    values[name] = f'market-watch-{component}:fixture'
                elif name.endswith('PORT'):
                    values[name] = '18000'
                elif name.endswith(('DIR', 'ENV')):
                    values[name] = directory if name.endswith('DIR') else str(fixture)
                elif 'DATABASE_URL' in name or name == 'TEST_POSTGRES_URL':
                    values[name] = 'postgresql+psycopg://fixture@postgres/fixture'
                else:
                    values[name] = 'fixture'
            values.update(overrides)
            # Compose's explicit --env-file prevents implicitly reading repo .env.
            fixture.write_text(''.join(f'{name}={value}\n' for name,value in values.items()))
            # Strip private env_file inputs after merging the actual files. Even
            # --no-env-resolution checks their existence in current Compose.
            services = set()
            for path in paths:
                block = (ROOT/path).read_text().split('services:\n',1)[1]
                for line in block.splitlines():
                    if line and not line.startswith((' ', '#')):
                        break
                    match = re.match(r'^  ([a-zA-Z0-9_-]+):',line)
                    if match:
                        services.add(match.group(1))
            private_override = Path(directory)/'private-env.override.yaml'
            private_override.write_text('services:\n'+''.join(
                f'  {name}:\n    env_file: !override []\n' for name in sorted(services)))
            command = ['docker','compose','--env-file',str(fixture)]
            for path in paths:
                command.extend(['-f',str(ROOT/path)])
            command.extend(['-f',str(private_override)])
            command.extend(['config','--no-env-resolution','--format','json'])
            result = subprocess.run(command,cwd=ROOT,env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            return json.loads(result.stdout)

    def test_maintained_acceptance_databases_and_connections_use_pg1424(self):
        candidates = list(ROOT.glob('compose*.yaml')) + list((ROOT/'deploy/ubuntu').glob('*.yaml')) + list((ROOT/'deploy/native-update').glob('*.yaml'))
        entries = [[p.relative_to(ROOT)] for p in candidates if 'image: postgres:' in p.read_text()]
        entries.extend([[Path('compose.acceptance.yaml')],
                        [Path('deploy/native-update/compose.tests.yaml'),Path('deploy/native-update/compose.acceptance.yaml')]])
        self.assertGreaterEqual(len(entries),15)
        for paths in entries:
            with self.subTest(paths=paths):
                rendered = self.render(paths)
                for name,service in rendered['services'].items():
                    image = service.get('image','')
                    if image.startswith('postgres:'):
                        self.assertEqual(image,PINNED_PG)
                        health = ' '.join(service['healthcheck']['test'])
                        self.assertIn('140024',health)
                        self.assertIn('pg_jit_available()',health)
                    if image.startswith('market-watch-api:') and 'sink' not in name:
                        self.assertEqual(service['environment'].get('ALERTS_DATABASE_EXPECTED_VERSION'),'140024',name)

    def test_production_defaults_off_even_with_generic_inherit_setting(self):
        rendered = self.render([Path('compose.production.yaml')],ALERTS_DATABASE_JIT='inherit')
        for name,service in rendered['services'].items():
            if name not in ('web','chart-origin'):
                self.assertEqual(service['environment']['ALERTS_DATABASE_JIT'],'off',name)
                self.assertEqual(service['environment']['ALERTS_YAHOO_ENABLED'],'true',name)
                self.assertNotIn('ALERTS_DATABASE_EXPECTED_VERSION',service['environment'])

    def test_only_selected_production_worker_can_enable_jit(self):
        for selected in ('chart-aggregation-worker','notify-worker','migrate','backup'):
            with self.subTest(selected=selected):
                key = 'MW_'+selected.upper().replace('-','_')+'_DATABASE_JIT'
                rendered = self.render([Path('compose.production.yaml')],**{key:'on'})
                for name,service in rendered['services'].items():
                    if name not in ('web','chart-origin'):
                        self.assertEqual(service['environment']['ALERTS_DATABASE_JIT'],
                                         'on' if name==selected else 'off',name)

    def test_new_pg14_default_does_not_reuse_pg17_volume(self):
        rendered = self.render([Path('compose.yaml')])
        volumes = rendered['services']['postgres']['volumes']
        self.assertEqual([volume['source'] for volume in volumes],['postgres14-data'])
