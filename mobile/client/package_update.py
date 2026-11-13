"""Publish one locally built debug APK and its manual-update manifest to Vite publicDir.

Run after assembleDebug and signature verification, before the web Docker build.
The APK/manifest are ignored local delivery artifacts, never source-control inputs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notes", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    build = Path(__file__).resolve().parent / "app/build/outputs/apk/debug"
    metadata = json.loads((build / "output-metadata.json").read_text())
    assert metadata["applicationId"] == "com.kookvv.marketwatch"
    assert len(metadata["elements"]) == 1
    element = metadata["elements"][0]
    apk = build / element["outputFile"]
    size = apk.stat().st_size
    assert 0 < size <= 128 * 1024 * 1024
    name = f"market-watch-{element['versionName']}-debug.apk"
    output = root / "web/vendor/downloads"
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(apk, output / name)
    manifest = {
        "applicationId": metadata["applicationId"],
        "versionCode": element["versionCode"],
        "versionName": element["versionName"],
        "apk": name,
        "size": size,
        "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
        "notes": args.notes,
    }
    (output / "android-update.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
