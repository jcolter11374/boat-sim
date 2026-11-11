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
    # Wrecks: how deep the wreck lies (m, as the card says) and its hull's length and
    # beam (m), for the faint outline seen through clear, shallow water (sea3d water.ts).
    depth_m: float | None = None
    size_m: tuple[float, float] | None = None


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
        depth_m=27,
        size_m=(66.5, 6.2),  # a Type VIIB U-boat
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
        depth_m=70,
        size_m=(52.4, 12.6),  # 172 ft by 41.5 ft
    ),
    # ---------- off the other ports (Take the helm's "Start from") ----------
    # One card near each group of launch points (sea3d/public/ports.json), wide
    # enough that the card shows at the start.
    Poi(
        "sandy-hook-light",
        "history",
        "Sandy Hook Lighthouse, 1764",
        ((40.4618, -74.0019),),
        70,
        "At the mouth of New York harbour stands the oldest lighthouse still working in "
        "the United States. It was first lit on 11 June 1764, paid for by a lottery after "
        "43 New York merchants asked for it. The tower is about 103 feet (31 m) tall and "
        "its light carries about 19 miles.",
        "US National Park Service",
        "https://www.nps.gov/places/000/sandy-hook-lighthouse.htm",
    ),
    Poi(
        "block-island-wind",
        "history",
        "Block Island Wind Farm",
        ((41.12, -71.51),),  # GUESS: off Block Island's south-east shore
        75,
        "Off Block Island, five turbines make up the first offshore wind farm in the "
        "United States. Together they make 30 megawatts, and they began commercial "
        "operation in December 2016.",
        "Rhode Island Coastal Resources Management Council",
        "https://www.crmc.ri.gov/windenergy/blockislandwind.html",
    ),
    Poi(
        "ss-portland",
        "wreck",
        "Steamship Portland, 1898",
        # GUESS: the middle of the Stellwagen Bank sanctuary; NOAA gives no position.
        ((42.37, -70.35),),
        60,
        "The night steamer Portland left Boston for Portland, Maine on 26 November 1898 and "
        "sailed into a storm now called the Portland Gale. Nobody survived: 192 or 193 "
        "people died. The wreck lies upright in over 400 feet (120 m) of water in the "
        "Stellwagen Bank sanctuary. Found in 1989 and confirmed in 2002, it is called the "
        "Titanic of New England.",
        "NOAA Stellwagen Bank National Marine Sanctuary",
        "https://stellwagen.noaa.gov/maritime/portland.html",
        depth_m=120,
        size_m=(85.6, 12.8),  # 281 ft by 42 ft
    ),
    Poi(
        "fundy-tides",
        "ocean",
        "The Gulf of Maine and the Bay of Fundy",
        # GUESS: a line from the middle of the Gulf of Maine to the mouth of the Bay.
        ((42.8, -68.6), (43.6, -66.1), (44.6, -66.4)),
        75,
        "This gulf and the Bay of Fundy north of it slosh back and forth about every 13 "
        "hours, close to the 12.4 hour beat of the ocean tide, so the tide builds up "
        "here. At the head of the bay it can rise more than 16 m (16.1 m was measured at "
        "Burntcoat Head). At full flood 25 million cubic metres of water a second pour into "
        "the Gulf, about 2,000 times what the St Lawrence river carries.",
        "The Canadian Encyclopedia",
        "https://thecanadianencyclopedia.ca/en/article/bay-of-fundy-and-gulf-of-maine",
    ),
    Poi(
        "birchtown",
        "history",
        "Birchtown, 1783",
        ((43.74, -65.37),),
        75,
        "In 1783 about 3,000 Black Loyalists, people who had sided with the British in the "
        "American War of Independence, sailed from New York to Nova Scotia. Many settled "
        "at Birchtown near Shelburne, then the largest free Black community in British "
        "North America. In 1792 about 1,200 of them sailed on to Sierra Leone and "
        "founded Freetown.",
        "The Canadian Encyclopedia",
        "https://thecanadianencyclopedia.ca/en/article/black-loyalists-in-british-north-america",
    ),
    Poi(
        "halifax-explosion",
        "history",
        "Halifax Explosion, 1917",
        ((44.67, -63.60),),  # the Narrows, Halifax harbour
        60,
        "Soon after 9 a.m. on 6 December 1917 the French ship Mont-Blanc, loaded with "
        "explosives for the war in Europe, collided with the Norwegian ship Imo in the "
        "narrowest part of Halifax harbour. The blast destroyed the north end of the city "
        "and raised a tsunami. About 2,000 people died, 9,000 were hurt and 25,000 lost "
        "their homes.",
        "The Canadian Encyclopedia",
        "https://www.thecanadianencyclopedia.ca/en/article/halifax-explosion-plain-language-summary",
    ),
    Poi(
        "sable-island",
        "wreck",
        "Sable Island",
        ((43.93, -59.91),),
        60,
        "A thin crescent of sand 42 km long and at most 1.3 km wide, 290 km south-east of "
        "Halifax. More than 350 ships have been wrecked on and around it, which is why it "
        "is called the Graveyard of the Atlantic. Wild horses live there (between 374 and "
        "590 in recent counts), and up to about 80,000 grey seal pups are born on it each "
        "winter. It became a national park in 2013.",
        "The Canadian Encyclopedia",
        "https://thecanadianencyclopedia.ca/en/article/sable-island-national-park-reserve",
    ),
    Poi(
        "louisbourg",
        "history",
        "Louisbourg",
        ((45.89, -59.98),),
        # Wide: Port Hawkesbury's launch point is about 105 km away.
        120,
        "France founded Louisbourg in 1713 to guard its fishing and trade in North America. "
        "British forces besieged and took the fortified town twice, in 1745 and 1758. From "
        "1961 to 1981 Parks Canada rebuilt about a quarter of it, the largest rebuilt "
        "18th century French fortified town in North America.",
        "Parks Canada",
        "https://www.pc.gc.ca/apps/dfhd/page_nhs_eng.aspx?id=303",
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
        depth_m=72,
        size_m=(212.2, 27.5),
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
        depth_m=3800,
        size_m=(269.1, 28.2),
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
        d = {k: v for k, v in asdict(p).items() if v is not None}
        d["at"] = [list(x) for x in p.at]
        if p.size_m:
            d["size_m"] = list(p.size_m)
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
