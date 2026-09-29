"""Install only the licensed chart library, record hashes; exclude third-party demos."""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path, PurePosixPath

parser = argparse.ArgumentParser()
parser.add_argument("archive", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
prefix = "TV_v31.1.0_0430/static/charting_library/"
manifest = {"archive_sha256": hashlib.sha256(args.archive.read_bytes()).hexdigest(), "files": {}}
with zipfile.ZipFile(args.archive) as archive:
    for entry in archive.infolist():
        if not entry.filename.startswith(prefix) or entry.is_dir():
            continue
        relative = PurePosixPath(entry.filename[len(prefix) :])
        if relative.is_absolute() or ".." in relative.parts or entry.file_size > 30_000_000:
            raise ValueError("Unsafe archive entry")
        content = archive.read(entry)
        target = root / "advanced-host/charting_library" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        manifest["files"][str(relative)] = hashlib.sha256(content).hexdigest()
(root / "advanced-host/library-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(
    "Installed",
    len(manifest["files"]),
    "library files; archive SHA256:",
    manifest["archive_sha256"],
)
