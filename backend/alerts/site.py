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
    if path.split("/", 1)[0] in {"api", "healthz", "readyz", "mcp", "assets"}:
        raise HTTPException(404, "Not found")
    if path == "favicon.svg":
        return FileResponse(ROOT / "favicon.svg", media_type="image/svg+xml")
    # All business and unknown locations use the same router/404 view. Never
    # resolve the requested path against the repository or swallow protocols.
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache"})
