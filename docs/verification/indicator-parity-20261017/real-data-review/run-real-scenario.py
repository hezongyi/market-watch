import json
import os
import subprocess
import sys
from pathlib import Path

task_dir = Path('/tmp/mw-issue74-20261017')
code = 'state.realScenario=' + json.dumps(json.loads(sys.argv[1])) + ';\n'
code += (task_dir / 'real-review-scenario.playwriter.js').read_text()
env = dict(os.environ, PLAYWRITER_TELEMETRY='0',
           PLAYWRITER_LOG_FILE_PATH=str(task_dir / 'playwriter-budget-relay.log'))
result = subprocess.run(['node', '/tmp/mw-issue74-npm-cache/_npx/945f35517ce0271a/node_modules/playwriter/dist/cli.js',
                         '-s', '3', '--timeout', '55000', '-e', code], env=env)
sys.exit(result.returncode)
