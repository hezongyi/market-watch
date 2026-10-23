#!/usr/bin/env python3
"""Read-only-source, isolated in-memory reproduction of calendar identity mismatch.

No network, credentials, running instances or on-disk databases are used.
Run with the repo's Python environment; --repo chooses the reviewed source tree.
"""
import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='/home/quant/repos/market-watch-composite-mapping-20261021')
    args = parser.parse_args()
    repo = Path(args.repo).resolve()
    sys.path[:0] = [str(repo / 'backend'), str(repo / 'backend/tests')]

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from alerts import storage
    from alerts.config import settings
    from alerts.composite_definitions import save_mapping
    from alerts.composite_matching import check_match, MappingDraft
    from alerts.composite_center import mapping_report
    from test_composite_definitions import prepare
    from test_market_contracts import identity
    import pytest

    engine = create_engine('sqlite://')
    storage.bootstrap(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    patch = pytest.MonkeyPatch()
    try:
        # prepare uses only synthetic account/token literals and an in-memory row.
        catalog_id = prepare(factory, patch)
        with factory.begin() as db:
            checked = check_match(db, identity().key, catalog_id)
            draft = MappingDraft.model_validate(checked['suggestion'])
            mapping = save_mapping(db, identity().key, catalog_id, draft, snapshot=checked['snapshot'])
            mapping_id = mapping.id
            before = mapping_report(db, mapping)

        patch.setattr(settings, 'oanda_calendar_version', settings.oanda_calendar_version + '-review-next')
        with factory.begin() as db:
            mapping = db.get(storage.RealtimeMapping, mapping_id)
            after = mapping_report(db, mapping)
            checked = check_match(db, identity().key, catalog_id, draft)
            rejected = False
            error = None
            try:
                save_mapping(db, identity().key, catalog_id, draft,
                    snapshot=checked['snapshot'], reuse_mapping_id=mapping.id)
            except ValueError as exc:
                rejected = True
                error = str(exc)
            result = {
                'reviewed_head': 'c4086d1f4c01c28afb519cc45e58f5c87b7e9d62',
                'database': 'isolated in-memory SQLite',
                'network_operations': 0,
                'synthetic_fixture_only': True,
                'before_calendar_change': {'valid_for_selection': before['valid_for_selection']},
                'after_calendar_change': {
                    'valid_for_selection': after['valid_for_selection'],
                    'mapping_check_status': checked['status'],
                    'reuse_save_rejected': rejected,
                    'reuse_save_error': error,
                },
            }
            assert before['valid_for_selection'] is True
            assert after['valid_for_selection'] is True
            assert checked['status'] == 'ready'
            assert rejected and error == '所选已保存配置已不适用，请重新选择并核对'
            print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        patch.undo()
        engine.dispose()


if __name__ == '__main__':
    main()
