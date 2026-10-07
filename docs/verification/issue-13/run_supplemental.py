"""Serial supplemental P0 runs; retain all existing baseline artifacts."""
import subprocess

from run_suite import ROOT, PREFIX, command, observe


def main():
    destination = ROOT / 'supplemental'
    destination.mkdir(exist_ok=True)
    if any(destination.iterdir()):
        raise SystemExit('Supplemental evidence already exists; no automatic overwrite or restart')
    try:
        subprocess.run(command(PREFIX + ['up','-d','--wait','postgres']),check=True)
        with (destination/'host.jsonl').open('x') as samples:
            for scenario in ('idle','mixed'):
                # Detailed errors may contain SQL parameters; keep process output
                # private until inspected, never pipe unreviewed exceptions to git.
                log = destination / (scenario+'-process.log')
                with log.open('x') as output:
                    log.chmod(0o600)
                    proc = subprocess.Popen(command(PREFIX + ['run','--rm','--name',
                        'mw-issue13-p0-supplemental','probe','python',
                        'docs/verification/issue-13/supplemental_probe.py',
                        '--scenario',scenario,'--seconds','300']),stdout=output,stderr=subprocess.STDOUT)
                    while proc.poll() is None:
                        observe(samples,scenario)
                        try: proc.wait(timeout=10)
                        except subprocess.TimeoutExpired: pass
                if proc.returncode:
                    raise SystemExit(f'{scenario} exited {proc.returncode}; inspect private log, no retry')
                print(scenario+' supplemental measurement completed',flush=True)
        print('SUPPLEMENTAL COMPLETE',flush=True)
    finally:
        subprocess.run(command(PREFIX+['stop','postgres']),check=True)
        print('Own PostgreSQL stopped; synthetic volume retained',flush=True)


if __name__=='__main__': main()
