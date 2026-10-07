"""Read the terminal PG snapshot without resetting or writing database data."""
import gzip
import json

from high_period_probe import ROOT, full_snapshots, sha


def main():
    target=ROOT/'final-snapshots.json.gz'
    if target.exists():
        raise SystemExit('Terminal snapshot already archived; no overwrite')
    result=json.loads((ROOT/'result.json').read_text())
    assert result['outcome']=='passed'
    snapshots=full_snapshots()
    assert sha(snapshots)==result['phases'][-1]['snapshot_sha256'], 'Database changed after completed probe'
    target.write_bytes(gzip.compress(json.dumps(snapshots,sort_keys=True).encode(),mtime=0))
    print('Terminal PG snapshot preserved and matches completed duplicate phase',flush=True)


if __name__=='__main__':
    main()
