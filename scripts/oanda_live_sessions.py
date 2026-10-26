"""Generate finite SG account-scoped status evidence; never alter history coverage.

Review the official hours and account/product applicability before using output
as ALERTS_OANDA_LIVE_SESSION_PROFILES. This tool has no network/database access.
"""
import argparse
import json
from datetime import datetime
from pathlib import Path

from alerts.calendar_profile import Profile

HOURS = 'https://www.oanda.com/sg-en/trading/hours-of-operation/'


def generate(scope, start, end, symbols):
    supported = {'EUR_USD': 17, 'GBP_USD': 17, 'XAU_USD': 18}
    if not symbols or set(symbols) - supported.keys():
        raise ValueError('Reviewed SG hours support only EUR_USD, GBP_USD and XAU_USD here')
    if (end - start).total_seconds() > 7*86400:
        raise ValueError('Re-review this operational profile at least weekly')
    result = {}
    for symbol in symbols:
        reopen = supported[symbol]*60+4  # Exclude the minute preceding published open.
        closures = [{'start': day*1440+17*60, 'end': day*1440+reopen} for day in range(4)]
        closures.append({'start': 4*1440+17*60, 'end': 6*1440+reopen})
        value = {'revision': 'oanda-sg-live-hours-reviewed-' + start.date().isoformat(), 'source_session': {
            'source': 'oanda', 'channel': 'v20', 'environment': 'practice',
            'provider_symbol': symbol, 'account_scope': scope, 'timezone': 'America/New_York',
            'reviewed_start': start.isoformat(), 'reviewed_end': end.isoformat(),
            'evidence_url': HOURS,
            'applicability': 'User-confirmed OANDA SG account; reviewed SG regular hours as a finite Practice scheduling plan only. Excludes boundary minutes; not quote availability, minute coverage or holiday completeness. Review the official holiday table for this interval.',
            'weekly_closures': closures}}
        result[symbol] = Profile.model_validate(value).model_dump(mode='json')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-scope', required=True, help='Opaque sha256 scope of the configured SG account')
    parser.add_argument('--reviewed-start', required=True)
    parser.add_argument('--reviewed-end', required=True)
    parser.add_argument('--symbols', default='EUR_USD,XAU_USD,GBP_USD')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = generate(args.account_scope, datetime.fromisoformat(args.reviewed_start),
        datetime.fromisoformat(args.reviewed_end), args.symbols.split(','))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    args.output.chmod(0o600)
