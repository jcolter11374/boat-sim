"""Channel buoys for the 3D practice view are read from real seamark tags, never made up."""

from boatsim.oceandata.seamarks import mark_from_tags, marks_from_overpass


def test_a_lit_green_can_is_a_port_hand_buoy_with_its_rhythm():
    m = mark_from_tags(
        38.95,
        -76.45,
        {
            "seamark:type": "buoy_lateral",
            "seamark:buoy_lateral:category": "port",
            "seamark:buoy_lateral:shape": "can",
            "seamark:buoy_lateral:colour": "green",
            "seamark:name": "1",
            "seamark:light:colour": "green",
            "seamark:light:character": "Fl",
            "seamark:light:period": "4",
        },
    )
    assert m["kind"] == "buoy" and m["side"] == "port" and m["shape"] == "can"
    assert m["light"] == {"colour": "green", "character": "Fl", "group": None, "period_s": 4.0}


def test_a_red_daybeacon_without_a_category_is_starboard_red_right_returning():
    m = mark_from_tags(
        38.9, -76.4, {"seamark:type": "beacon_lateral", "seamark:beacon_lateral:colour": "red"}
    )
    assert (
        m["kind"] == "beacon"
        and m["side"] == "starboard"
        and m["shape"] == "pile"
        and m["light"] is None
    )


def test_other_seamark_types_and_ways_are_left_out():
    reply = {
        "elements": [
            {"type": "node", "lat": 1, "lon": 2, "tags": {"seamark:type": "light_minor"}},
            {"type": "way", "id": 5, "tags": {"seamark:type": "buoy_lateral"}},
            {"type": "node", "lat": 3, "lon": 4, "tags": {"seamark:type": "buoy_safe_water"}},
        ]
    }
    marks = marks_from_overpass(reply)
    assert [m["side"] for m in marks] == ["safe"]
