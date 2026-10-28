"""Start one of the fixed background runtime profiles."""

import argparse
import logging

from . import market_runtime
from .runtime_supervisor import RuntimeGroupError, exit_if_unstopped


def run(profile, *, stop=None, handle_signals=True, on_alert=None):
    if profile == "alert":
        from . import alert_runtime

        alert_runtime.run(stop=stop, handle_signals=handle_signals, on_alert=on_alert)
    elif profile == "market":
        market_runtime.run(stop=stop, handle_signals=handle_signals)
    else:
        raise ValueError(f"Unsupported runtime profile: {profile}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("market", "alert"), required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        run(args.profile)
    except RuntimeGroupError as error:
        logging.error("%s", error)
        # Profiles must handle this while holding their ownership locks. Keep
        # a fallback for failures outside the normal profile assembly.
        exit_if_unstopped(error)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
