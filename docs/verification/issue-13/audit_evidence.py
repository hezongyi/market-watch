"""Verify saved evidence bytes relative to this directory, without rewriting them."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    manifest = json.loads((HERE/'evidence-manifest.json').read_text())
    failures = []
    for name, expected in manifest['files'].items():
        path = HERE/name
        if not path.is_file():
            failures.append(f'{name}: missing')
        elif path.stat().st_size != expected['bytes'] or hashlib.sha256(
                path.read_bytes()).hexdigest() != expected['sha256']:
            failures.append(f'{name}: bytes or SHA256 mismatch')
    if failures:
        raise SystemExit('\n'.join(failures))
    print(f"Evidence bytes verified: {len(manifest['files'])} files; Issue13 completion is not implied")


if __name__ == '__main__':
    main()
