#!/usr/bin/env python3
"""Prevent untracked Market Watch builds; pass other Docker commands through."""

import os
import sys
from pathlib import Path


def guarded_args(args, cwd):
    scoped = any(p.startswith("market-watch") for p in Path(cwd).parts) or any(
        "market-watch" in a or "mw-" in a for a in args
    )
    if not scoped:
        return args
    # Strip only Docker global options to locate its subcommand.
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] in ("--host", "-H", "--context", "-c", "--config", "--log-level", "-l"):
            i += 2
        else:
            i += 1
    words = args[i:]
    if (
        words[:1] == ["build"]
        or words[:2] == ["image", "build"]
        or (words[:1] == ["buildx"] and any(a in ("build", "bake") for a in words[1:]))
        or (
            words[:1] == ["compose"]
            and ("build" in words[1:] or "watch" in words[1:] or "--build" in words[1:])
        )
    ):
        raise ValueError(
            "Market Watch 构建请使用 mw-docker build / compose-build，"
            "以记录任务归属并使用专用 BuildKit。"
        )
    if (
        words[:1] == ["compose"]
        and any(w in words[1:] for w in ("up", "create"))
        and "--no-build" not in words
    ):
        return args + ["--no-build"]
    return args


def main():
    try:
        args = guarded_args(sys.argv[1:], Path.cwd())
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    os.execv("/usr/bin/docker", ["/usr/bin/docker", *args])


if __name__ == "__main__":
    sys.exit(main())
