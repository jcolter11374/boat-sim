"""Points of interest: wrecks, history and ocean facts along the route.

When a boat's track passes within ``radius_km`` of a point, the voyage
replay and Take the helm show a card (sea3d/src/pois.ts). Every card has a
source link; the text is in our own words, checked against that source.

Positions: wrecks and places are where the source puts them. Ocean features
that are regions or lines (the Gulf Stream, the Sargasso Sea, the ridge) are a
few points along them, marked ``# GUESS`` where the path is our sketch of a
feature that moves about.

Left out on purpose: the Lusitania (51.4 N) and the Norse sites in
Newfoundland and Greenland lie north of the corridor (28-50 N), so no boat on
our route comes near them.

    python -m boatsim.oceandata.pois --out sea3d/public/pois.json
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

KINDS = ("wreck", "history", "ocean")
OUT = Path(__file__).resolve().parents[3] / "sea3d" / "public" / "pois.json"


@dataclass(frozen=True)
class Poi:
    id: str
    kind: str  # wreck | history | ocean
    title: str
    at: tuple[tuple[float, float], ...]  # (lat, lon) points; a line is several
    radius_km: float  # a card shows when the track comes this close to any point
    text: str
    source: str
    url: str


POIS: list[Poi] = [
    # ---------- near the drop, off Virginia and North Carolina ----------
    Poi(
        "cape-henry",
        "history",
        "Cape Henry, 1607",
        ((36.926, -76.006),),
        # Wide on purpose: the drop is 100 km out from the Bay mouth.
        130,
        "In April 1607, after four and a half months at sea, 144 English settlers came "
        "ashore at the south side of the Bay mouth, put up a wooden cross and named the "
        "cape. About three weeks later they founded Jamestown. "
        "The granite cross there now was put up in 1935.",
        "US National Park Service",
        "https://home.nps.gov/came/learn/historyculture/index.htm",
    ),
    Poi(
        "battle-of-the-capes",
        "history",
        "Battle of the Capes, 1781",
        ((36.95, -75.75),),  # GUESS: off the Bay mouth; the fleets moved about all day
        130,
        "On 5 September 1781 a French fleet under de Grasse fought 19 British warships off "
        "this coast. The British lost 90 men killed and the French kept control of the "
        "Bay. With no help able to come by sea, the British army at Yorktown under "
        "Cornwallis surrendered on 19 October, a turning point of the American War of "
        "Independence.",
        "US National Park Service",
        "https://home.nps.gov/york/learn/historyculture/battle-of-the-capes.htm",
    ),
    Poi(
        "u-85",
        "wreck",
        "U-boat U-85",
        # GUESS: to a few km. NOAA says about 14 miles east of Oregon Inlet; uboat.net
        # says about 18 miles east of Nags Head. Both put it here.
        ((35.92, -75.28),),
        90,
        "A German submarine lies about 27 m down off Oregon Inlet. On 14 April 1942 the "
        "US destroyer Roper sank it: the first U-boat sunk by US forces off the East "
        "Coast in the Second World War.",
        "NOAA Monitor National Marine Sanctuary",
        "https://monitor.noaa.gov/shipwrecks/u-85.html",
    ),
    Poi(
        "uss-monitor",
        "wreck",
        "USS Monitor",
        ((35.00195, -75.40633),),
        90,
        "The Union's famous Civil War ironclad sank in a storm off Cape Hatteras on 31 "
        "December 1862; 16 of the 62 men aboard died. It lies about 70 m down, and in "
        "1975 the wreck became the first US national marine sanctuary.",
        "NOAA Monitor National Marine Sanctuary",
        "https://monitor.noaa.gov/shipwrecks/uss_monitor.html",
    ),
    # ---------- the western ocean ----------
    Poi(
        "gulf-stream",
        "ocean",
        "The Gulf Stream",
        # GUESS: a sketch of its usual path after it leaves Cape Hatteras; it wanders
        # by 100 km or more from week to week.
        (
            (35.5, -74.6),
            (36.4, -72.5),
            (37.3, -70.0),
            (38.2, -67.0),
            (39.0, -64.0),
            (39.8, -60.0),
            (40.5, -55.0),
        ),
        80,
        "A river of warm water in the sea, flowing north-east. It averages about 6 km/h "
        "and can run near 9 km/h, faster than the kayak's motors push it, and it carries "
        "more water than all the world's rivers put together. Further north and east it "
        "slows to under 2 km/h.",
        "NOAA National Ocean Service",
        "https://oceanservice.noaa.gov/facts/gulfstreamspeed.html",
    ),
    Poi(
        "andrea-doria",
        "wreck",
        "Andrea Doria",
        ((40.4917, -69.8433),),  # position: wreckhunter.net wreck data page
        120,
        "The Italian liner Andrea Doria was hit in fog by the Swedish liner Stockholm "
        "late on 25 July 1956, about 45 miles south of Nantucket. It took 11 hours to "
        "sink, long enough for 1,660 people to be rescued; 51 died. The wreck lies about "
        "72 m down.",
        "History.com (this day in history)",
        "https://www.history.com/this-day-in-history/july-25/ships-collide-off-nantucket",
    ),
    Poi(
        "bermuda-triangle",
        "ocean",
        "The 'Bermuda Triangle'",
        ((32.3, -64.8),),  # Bermuda, the triangle's north-east corner
        300,
        "You're near Bermuda, one corner of the famous triangle. NOAA's answer: ships and "
        "planes go missing here no more often than in any busy stretch of ocean, and "
        "storms, the Gulf Stream and shallow reefs explain the losses. The name isn't "
        "official and there are no official edges.",
        "NOAA National Ocean Service",
        "https://oceanservice.noaa.gov/facts/bermudatri.html",
    ),
    Poi(
        "sargasso-sea",
        "ocean",
        "The Sargasso Sea",
        # GUESS: its northern part; the sea is bounded by currents, not coasts.
        ((33.5, -66.0), (33.5, -58.0), (33.5, -50.0), (33.0, -42.0)),
        250,
        "The only sea with no coast: four currents, the Gulf Stream among them, fence it "
        "in. Mats of floating seaweed called "
        "sargassum give it its name; young turtles shelter in them, and eels and marlin "
        "swim here to spawn.",
        "NOAA National Ocean Service",
        "https://oceanservice.noaa.gov/facts/sargassosea.html",
    ),
    Poi(
        "grand-banks",
        "ocean",
        "Fog off the Grand Banks",
        ((43.5, -50.5), (44.0, -48.0)),  # GUESS: the southern tail of the Banks
        250,
        "To the north are the Grand Banks of Newfoundland, where the cold Labrador "
        "Current meets the warm Gulf Stream. Where they mix, the fog is famous for "
        "lasting days, and the cold current carries icebergs down from Greenland: nearly "
        "500 reach the shipping lanes in an average year.",
        "US Coast Guard International Ice Patrol",
        "https://navcen.uscg.gov/node/31306",
    ),
    Poi(
        "titanic",
        "wreck",
        "RMS Titanic",
        # GUESS: to a km or two. NOAA gives no position; this is the widely published
        # position of the bow section.
        ((41.732, -49.946),),
        150,
        "Not far from here, nearly 4 km down, lies the Titanic. It hit an iceberg and "
        "sank on 15 April 1912, about 350 nautical miles off Newfoundland, and more than "
        "1,500 people died. The wreck was found in 1985 by a joint US-French team led by "
        "Robert Ballard and Jean-Louis Michel.",
        "NOAA",
        "https://noaa.gov/node/10822",
    ),
    # ---------- mid-ocean and the Azores ----------
    Poi(
        "azores-high",
        "ocean",
        "The Azores High",
        ((35.0, -32.0),),  # GUESS: where it usually sits, south of the Azores
        450,
        "You're sailing near the Azores High, a big area of high air pressure that "
        "usually sits south of the islands. Paired with the Icelandic Low far to the "
        "north, it sets the westerly winds across to Europe: the bigger the difference "
        "in pressure between them, the stronger the westerlies and the storms.",
        "Met Office",
        "https://www.metoffice.gov.uk/blog/2025/what-is-the-azores-high",
    ),
    Poi(
        "mid-atlantic-ridge",
        "ocean",
        "The Mid-Atlantic Ridge",
        # GUESS: a sketch of the ridge crest through the Azores (near the Rainbow, Lucky
        # Strike and Menez Gwen vent fields).
        ((35.0, -35.5), (36.2, -33.9), (37.3, -32.3), (38.3, -30.5), (39.8, -29.6), (42.0, -29.2)),
        70,
        "You're crossing the seam of the Atlantic. Deep below, the plates of the earth's "
        "crust pull apart about 2.5 cm a year, and new sea floor forms between them. Over "
        "100 to 200 million years this spreading grew the Atlantic from a narrow inlet "
        "into an ocean.",
        "US Geological Survey",
        "https://pubs.usgs.gov/gip/dynamic/understanding.html",
    ),
    Poi(
        "horta-cables",
        "history",
        "Horta, the cable town",
        ((38.532, -28.627),),
        70,
        "Horta on Faial was once a crossroads of the world's telegraph. The first cable "
        "reached it in 1893, and by 1928 fifteen undersea cables linked it to Britain, "
        "the US, Canada, Ireland, France, Germany, Italy and Cape Verde. The last cable "
        "company left in 1969.",
        "Explore Faial Island",
        "https://www.explorefaialisland.com/en/?p=4997",
    ),
    Poi(
        "azores-whaling",
        "history",
        "Azores whalers",
        ((38.40, -28.25),),  # Lajes do Pico
        70,
        "From Pico and its neighbours, Azoreans hunted sperm whales from open boats with "
        "oars, sails and hand-thrown harpoons until 1987. The old whaleboats now race, and "
        "the whales bring whale watchers instead.",
        "National Geographic",
        "https://www.nationalgeographic.com/adventure/article/130613-azores-whalers-culture-history-marine-science",
    ),
    Poi(
        "columbus-santa-maria",
        "history",
        "Columbus at Santa Maria, 1493",
        ((37.006, -25.160),),  # Anjos, on the north coast of Santa Maria
        80,
        "Coming home from his first voyage in February 1493, Columbus was caught by a "
        "storm and sheltered at Santa Maria. His men went ashore to give thanks at a "
        "shrine, and the unfriendly Portuguese held them for a time. Once freed they "
        "sailed on, still in storms, and the battered Niña reached Lisbon.",
        "Britannica",
        "https://www.britannica.com/biography/Christopher-Columbus/The-first-voyage",
    ),
    # ---------- the finish, off Portugal ----------
    Poi(
        "gorringe-bank",
        "ocean",
        "Gorringe Bank",
        ((36.53, -11.57),),  # Gettysburg peak
        80,
        "A mountain under the sea, about 160 nautical miles off Portugal. It rises from "
        "5,000 m down, and its two peaks, Gettysburg and Ormonde, come to within 50 m of "
        "the surface.",
        "Oceana",
        "https://europe.oceana.org/wp-content/uploads/sites/26/fact_sheet_gorringe.pdf",
    ),
    Poi(
        "cabo-da-roca",
        "history",
        "Cabo da Roca",
        ((38.7819, -9.4973),),
        # Wide on purpose: the finish circle is about 355 km out from here.
        380,
        "Due east is Cabo da Roca, the westernmost point of mainland Europe. A lighthouse "
        "has shone there since 1772, and a stone marks it with the poet Camões's line "
        "'where the land ends and the sea begins'.",
        "Parques de Sintra",
        "https://bilheteira.parquesdesintra.pt/info/farol-cabo-da-roca-visita-essencial/1188/en",
    ),
    Poi(
        "lisbon-1755",
        "history",
        "The Lisbon earthquake, 1755",
        ((38.71, -9.14),),
        400,
        "On the morning of 1 November 1755 an earthquake of about magnitude 8.7 shook "
        "Lisbon, and a tsunami struck the riverfront. About a quarter of the city's "
        "250,000 people died.",
        "US Geological Survey (archived page)",
        "https://webarchive.library.unt.edu/eot2008/20090109025722/http://earthquake.usgs.gov/regional/world/events/1755_11_01.php",
    ),
]


def catalog() -> dict:
    out = []
    for p in POIS:
        d = asdict(p)
        d["at"] = [list(x) for x in p.at]
        out.append(d)
    return {
        "pois": out,
        "notes": "A card shows when the track passes within radius_km of any point in 'at'.",
    }


def dumps() -> str:
    return json.dumps(catalog(), indent=1, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Points of interest along the route")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args(argv)
    Path(a.out).write_text(dumps(), encoding="utf-8")


if __name__ == "__main__":
    main()
