"""Local operator credential management. Token is emitted once to a protected file."""

import argparse
import json
import os

from sqlalchemy import select

from ..storage import AgentCredential, bootstrap, now_ms, transaction
from .auth import issue, revoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("issue")
    create.add_argument("--agent", required=True)
    create.add_argument("--scope", action="append", required=True)
    create.add_argument("--hours", type=int, default=24)
    create.add_argument("--output", required=True)
    remove = sub.add_parser("revoke")
    remove.add_argument("--hash", required=True)
    sub.add_parser("list")
    args = parser.parse_args()
    bootstrap()
    if args.command == "issue":
        if not 1 <= args.hours <= 8760:
            parser.error("hours must be 1..8760")
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            token = issue(args.agent, args.scope, now_ms() + args.hours * 3600000)
            with os.fdopen(fd, "w") as output:
                output.write(token + "\n")
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            os.unlink(args.output)
            raise
        print("Credential written to protected output file")
    elif args.command == "revoke":
        revoke(args.hash)
        print("Credential revoked")
    else:
        with transaction() as db:
            print(
                json.dumps(
                    [
                        {
                            key: getattr(row, key)
                            for key in (
                                "agent_id",
                                "token_hash",
                                "scopes",
                                "expires_at",
                                "revoked_at",
                            )
                        }
                        for row in db.scalars(select(AgentCredential))
                    ],
                    indent=2,
                )
            )


if __name__ == "__main__":
    main()
