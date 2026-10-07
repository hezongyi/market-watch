"""Run own bounded TCP consumer probe only after supplemental runs finish."""
import subprocess

from run_suite import ROOT, PREFIX, command, observe


def main():
    if any(ROOT.joinpath('supplemental',name).exists() is False for name in ('idle.json','mixed.json')):
        raise SystemExit('Finish supplemental runs before resetting their fixture')
    # A successful output alone does not prove the previous run has stopped.
    running=subprocess.check_output(command(['docker','ps','--filter',
        'name=^/mw-issue13-p0-supplemental$','--format','{{.Names}}']),text=True).strip()
    if running:
        raise SystemExit('Supplemental process still running; no concurrent reset')
    if (ROOT/'network-alert').exists() or (ROOT/'network-alert-host.jsonl').exists():
        raise SystemExit('Network/alert evidence already exists; explicitly archive before retry')
    try:
        subprocess.run(command(PREFIX+['up','-d','--wait','postgres']),check=True)
        log=ROOT/'network-alert-process.log'
        with log.open('x') as output, (ROOT/'network-alert-host.jsonl').open('x') as samples:
            log.chmod(0o600)
            proc=subprocess.Popen(command(PREFIX+['run','--rm','--name','mw-issue13-p0-network',
                '-p','127.0.0.1:19614:8000','probe','python',
                'docs/verification/issue-13/network_alert_probe.py']),stdout=output,stderr=subprocess.STDOUT)
            host_reached=False
            while proc.poll() is None:
                observe(samples,'network-alert')
                if not host_reached:
                    try:
                        import urllib.error
                        import urllib.request
                        urllib.request.urlopen('http://127.0.0.1:19614/api/instruments',timeout=2)
                        raise SystemExit('Protected API unexpectedly allowed anonymous host access')
                    except urllib.error.HTTPError as error:
                        if error.code==401:
                            host_reached=True
                            print('Ubuntu host TCP mapping reached actual protected API (401)',flush=True)
                    except (OSError,TimeoutError):pass
                try:proc.wait(timeout=10)
                except subprocess.TimeoutExpired:pass
        if proc.returncode:
            raise SystemExit(f'Network/alert probe exited {proc.returncode}; inspect private log, no retry')
        if not host_reached:raise SystemExit('Host address not verified during probe')
        (ROOT/'network-alert-host-access.txt').write_text('Ubuntu quant-server 127.0.0.1:19614/api/instruments returned HTTP 401 while actual TCP app was running. No anonymous data access. Probe removed after exit.\n')
        print('NETWORK ALERT COMPLETE',flush=True)
    finally:
        subprocess.run(command(PREFIX+['stop','postgres']),check=True)
        print('Own PostgreSQL stopped; synthetic volume retained',flush=True)


if __name__=='__main__':main()
