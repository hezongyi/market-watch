"""Historical state decoding remains compatible after executor retirement."""
from alerts import storage
from alerts.domain import State
from alerts.storage import state_dict


def test_state_roundtrip(database):
    assert storage.state_from(state_dict(State())) == State()
