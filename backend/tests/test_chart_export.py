import csv
import io

import pytest
from alerts.chart_export import chart_csv


def test_export_preserves_prices_time_warmup_and_missing_volume():
    bars = [
        dict(
            start=t,
            end=t + 60000,
            open="1.1234567890",
            high="2",
            low="-0.1",
            close="1",
            complete=False,
            revision=2,
        )
        for t in (0, 60000)
    ]
    page = dict(
        bars=bars,
        basis="bid",
        calendar="ny17",
        indicators=[
            dict(
                name="EMA",
                series=[
                    dict(
                        key="value", values=[dict(time=0, value=None), dict(time=60000, value=1.25)]
                    )
                ],
            )
        ],
    )
    result = chart_csv(page, instrument='=HYPERLINK("bad")', timeframe="M1")
    rows = list(csv.DictReader(io.StringIO(result.decode("utf-8-sig"))))
    assert rows[0]["open"] == "1.1234567890"
    assert rows[0]["low"] == "-0.1"
    assert rows[0]["start_utc"] == "1970-01-01T00:00:00.000+00:00"
    assert rows[0]["instrument"].startswith("'=")
    assert rows[0]["complete"] == "false"
    assert rows[0]["volume"] == rows[0]["python:1:EMA:value"] == ""
    assert rows[1]["python:1:EMA:value"] == "1.25"
    page["bars"] = bars + bars
    with pytest.raises(ValueError, match="chronological"):
        chart_csv(page, instrument="EURUSD", timeframe="M1")
