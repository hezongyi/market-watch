"""Application diagnostics that Uvicorn's server-only defaults do not enable."""

import logging


def configure_api_logging():
    # This logger emits only the redacted snapshot rejection/correlation record.
    # Do not enable INFO globally: provider and HTTP logs may contain identities.
    logger = logging.getLogger('alerts.provider_display_snapshots')
    logger.setLevel(logging.INFO)
    if not logger.hasHandlers():
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter('%(levelname)s %(name)s %(message)s'))
        logger.addHandler(handler)
