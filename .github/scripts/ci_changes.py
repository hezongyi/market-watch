"""Classify CI inputs without installing application dependencies."""

import argparse
import os
import subprocess
import tomllib
from pathlib import Path, PurePosixPath


def git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True
    ).stdout


def documentation(path: str) -> bool:
    item = PurePosixPath(path)
    if item.suffix == ".md":
        return (
            item.parent == PurePosixPath(".")
            or path.startswith(("docs/", "deploy/", ".github/ISSUE_TEMPLATE/"))
            or path == ".github/PULL_REQUEST_TEMPLATE.md"
        )
    return path.startswith("docs/") and item.suffix.lower() in {
        ".rst", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"
    }


def version_only(repo: Path, base: str, head: str) -> bool:
    try:
        before = tomllib.loads(git(repo, "show", f"{base}:pyproject.toml").decode())
        after = tomllib.loads(git(repo, "show", f"{head}:pyproject.toml").decode())
        old_version = before["project"].pop("version")
        new_version = after["project"].pop("version")
    except (
        subprocess.CalledProcessError, tomllib.TOMLDecodeError,
        UnicodeError, KeyError, TypeError, AttributeError,
    ):
        return False
    return (
        isinstance(old_version, str)
        and isinstance(new_version, str)
        and bool(old_version)
        and bool(new_version)
        and old_version != new_version
        and before == after
    )


def classify(repo: Path, base: str, head: str, event: str) -> dict[str, bool]:
    initial = bool(base) and set(base) == {"0"}
    if event == "pull_request" and not initial:
        base = git(repo, "merge-base", base, head).decode().strip()
    if initial:
        # With no previous tree, inspect every input, including merge commits.
        raw = git(repo, "ls-tree", "-r", "--name-only", "-z", head)
    else:
        # Keep deletion paths: a code -> docs rename must still run code checks.
        raw = git(repo, "diff", "--name-only", "--no-renames", "-z", base, head)
    paths = [name.decode("utf-8", errors="surrogateescape") for name in raw.split(b"\0") if name]
    backend = any(
        path.startswith(("backend/", "migrations/"))
        or path in {"requirements.lock", "alembic.ini", "Dockerfile"}
        for path in paths
    )
    if "pyproject.toml" in paths:
        backend = backend or initial or not version_only(repo, base, head)
    return {
        "docs_only": bool(paths) and all(documentation(path) for path in paths),
        "backend_changed": backend,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--event", choices=("pull_request", "push"), required=True)
    args = parser.parse_args()
    result = classify(Path.cwd(), args.base, args.head, args.event)
    lines = "".join(f"{key}={str(value).lower()}\n" for key, value in result.items())
    print(lines, end="")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as target:
            target.write(lines)


if __name__ == "__main__":
    main()
