"""Two read-only statements per sample, preserving actual series identities."""

from sqlalchemy import select

from alerts.storage import ChartAlert, ChartPublishedBar, Instrument


def published_query(identities, *, start=None):
    if start is not None:
        return select(ChartPublishedBar.instrument_id, ChartPublishedBar.payload).where(
            ChartPublishedBar.instrument_id.in_(identities),
            ChartPublishedBar.timeframe == "M1", ChartPublishedBar.start == start)
    # One indexed top-one lookup per actual identity inside a single statement.
    # The (instrument_id, timeframe, start) PK supplies the descending lookup;
    # no DISTINCT scan/materialization of every historical M1 payload is needed.
    latest = select(ChartPublishedBar.payload).where(
        ChartPublishedBar.instrument_id == Instrument.id,
        ChartPublishedBar.timeframe == "M1").order_by(
            ChartPublishedBar.start.desc()).limit(1).correlate(Instrument).scalar_subquery()
    return select(Instrument.id, latest).where(Instrument.id.in_(identities))


def read_sample(db, alerts, *, start=None):
    payloads = dict(db.execute(published_query(tuple(alerts), start=start)).all())
    records = {row.id: row for row in db.execute(select(
        ChartAlert.id, ChartAlert.state, ChartAlert.health, ChartAlert.count, ChartAlert.status
    ).where(ChartAlert.id.in_(tuple(alerts.values()))))}
    data = {}
    for ident, alert_id in alerts.items():
        payload = payloads.get(ident)
        if payload is None:
            raise KeyError("Missing published M1 payload for " + ident)
        record = records[alert_id]
        data[ident] = dict(published_observed_at=payload["observed_at"], payload=payload,
                           sequence=record.state.get("sequence"), health=record.health,
                           count=record.count, status=record.status)
    return data
