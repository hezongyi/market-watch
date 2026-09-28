"""Serve the built website alongside the API for a single-host deployment."""

from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api import app

ROOT = Path(__file__).resolve().parents[2] / "web" / "dist"
if not (ROOT / "index.html").is_file():
    raise RuntimeError("Build the website with npm run build before starting alerts.site")
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="web-assets")


@app.get("/{path:path}", include_in_schema=False)
def website(path: str):
    if path.startswith(("api/", "healthz/", "readyz/")) or path == "api":
        raise HTTPException(404, "Not found")
    # Only known client routes get an HTML fallback; never expose repository files.
    if path not in {"", "signals", "replay", "settings"}:
        raise HTTPException(404, "Not found")
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache"})
