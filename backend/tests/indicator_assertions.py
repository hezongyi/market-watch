"""Compare indicator results without requiring identical execution costs."""

EXECUTION_DIAGNOSTICS = frozenset({
    "input_cache", "sql_payload_rows", "prefix_credential_queries", "result_cache",
    "calculation_steps", "checkpoint_index", "input_accepted_at_ms",
})


def stable_indicators(page):
    """Keep values, input identities, coverage and input_rows strictly comparable."""
    results = []
    for item in page["indicators"]:
        calculation = dict(item["calculation"])
        calculation["execution"] = {
            key: value for key, value in calculation["execution"].items()
            if key not in EXECUTION_DIAGNOSTICS
        }
        results.append({**item, "calculation": calculation})
    return results
