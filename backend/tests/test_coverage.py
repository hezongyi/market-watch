from alerts.coverage import covers_interval


def test_adjacent_and_overlapping_queries_cover_but_holes_do_not():
    assert covers_interval([{"start": 0, "end": 60}, {"start": 60, "end": 120}], 0, 120)
    assert covers_interval([{"start": 50, "end": 130}, {"start": -5, "end": 70}], 0, 120)
    assert not covers_interval([{"start": 0, "end": 59}, {"start": 60, "end": 120}], 0, 120)
    assert not covers_interval([{"start": 1, "end": 120}], 0, 120)
    assert not covers_interval([{"start": 0, "end": 119}], 0, 120)


def test_empty_invalid_and_disjoint_queries_do_not_claim_coverage():
    assert not covers_interval([], 0, 120)
    assert not covers_interval([{"start": 120, "end": 0}], 0, 120)
    assert not covers_interval([{"start": 0, "end": 120}], 60, 60)
    assert not covers_interval([{"start": -60, "end": 0}, {"start": 120, "end": 180}], 0, 120)
