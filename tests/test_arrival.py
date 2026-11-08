from boatsim.runner import in_europe


def test_azores_count():
    assert in_europe(38.7, -27.2)  # Terceira


def test_portugal_coast_counts():
    assert in_europe(39.5, -9.6)


def test_mid_atlantic_does_not():
    assert not in_europe(40.0, -45.0)


def test_bay_mouth_does_not():
    assert not in_europe(36.9, -75.7)
