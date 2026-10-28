"""Independent ChartAlert runtime used when market-loop contention is measured."""

from . import runtime_health
from .market_runtime import chart_alert_ownership
from .runtime_supervisor import Loop, RuntimeGroupError, exit_if_unstopped, run_group


def run(*, stop=None, handle_signals=True, on_alert=None):
    from . import alert_monitor
    from .storage import bootstrap, engine
    from .swing_sr import register_indicator

    register_indicator()
    bootstrap()
    with chart_alert_ownership(engine):
        boot_id = runtime_health.boot()
        reporter = runtime_health.Progress("market", "chart_alert", boot_id)
        reporter.claim()

        def execute(shared_stop):
            with runtime_health.reporting(reporter):
                alert_monitor.run(shared_stop, on_alert=on_alert)

        try:
            run_group([Loop("chart_alert", execute)], stop=stop,
                      on_state=lambda _role, state, error: reporter.record(
                          state=state, error=error, completed=False),
                      handle_signals=handle_signals)
        except RuntimeGroupError as error:
            exit_if_unstopped(error)
            raise
