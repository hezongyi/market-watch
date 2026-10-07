"""Pure history-center reads use the same fixed inputs as browser endpoints."""

from .. import data_center
from ..history_artifacts import chart_page
from ..history_comparison import report as comparison_report
from ..history_request_evidence import report as request_report
from ..history_retention import references
from ..history_versions import version_report
from ..storage import transaction
from .context import CapabilityError
from .models import (
    ManagedBarsQuery,
    ManagedCoverageQuery,
    ManagedDatasetQuery,
    ManagedListQuery,
    ManagedTasksQuery,
    ManagedVersionQuery,
    Record,
)
from .registry import Capability


def invoke(function, *args, **kwargs):
    try:
        with transaction() as db:
            return function(db, *args, **kwargs)
    except ValueError as error:
        raise CapabilityError("DATA_UNAVAILABLE", str(error)) from None


def register_history(registry):
    entries = [
        ("history_list_datasets", "List managed backtest datasets by source, phase and per-period availability. Pure read; no live demand.", ManagedListQuery,
         lambda ctx, q: invoke(data_center.dataset_list, **q.model_dump())),
        ("history_get_dataset", "Managed dataset, maintenance plan and explicit per-period published parent versions. No subscriptions.", ManagedDatasetQuery,
         lambda ctx, q: invoke(data_center.dataset_detail, q.dataset_id)),
        ("history_list_tasks", "Read paginated download/derivation tasks. M1 published is distinct from all requested periods completed.", ManagedTasksQuery,
         lambda ctx, q: invoke(data_center.task_list, **q.model_dump())),
        ("history_get_version", "Immutable source M1 manifest and payload availability; never substitute another version.", ManagedVersionQuery,
         lambda ctx, q: invoke(version_report, q.version_id)),
        ("history_get_comparison", "Compare a fixed publication with its fixed parent or previous publication: manifests, periods and comparable partition checksums. Does not infer minute price revision counts or create demand.", ManagedVersionQuery,
         lambda ctx, q: invoke(comparison_report, q.version_id)),
        ("history_get_bars", "Fixed-version published period bars with separate closure, confirmation and coverage facts. Latest-first pages return ascending UTC bars and an exclusive next_before cursor. No download or realtime demand.", ManagedBarsQuery,
         lambda ctx, q: invoke(chart_page, q.version_id, q.timeframe, before=q.before, count=q.count)),
        ("history_get_coverage", "Fixed-version observed/unknown/confirmed-closed/conflict intervals with finite source evidence, never infer closures from empty responses.", ManagedCoverageQuery,
         lambda ctx, q: invoke(data_center.coverage_report, q.version_id, page=q.page, page_size=q.page_size)),
        ("history_get_requests", "Safe durable read outcomes, failed ranges and later successes, distinct from missing-minute classification. Older versions may have no request evidence.", ManagedCoverageQuery,
         lambda ctx, q: invoke(request_report, q.version_id, page=q.page, page_size=q.page_size)),
        ("history_get_references", "Read durable references and active tasks that block price payload reclamation. No deletion.", ManagedDatasetQuery,
         lambda ctx, q: invoke(references, q.dataset_id)),
    ]
    for name, description, model, handler in entries:
        registry.register(Capability(name, description, model, Record, frozenset({"market:read"}), "read", handler))
