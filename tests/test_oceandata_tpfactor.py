import math

import numpy as np

from boatsim.oceandata import tpfactor as tf

# NDBC's 47 spectral bands (0.02-0.485 Hz)
F = np.array(
    [0.02, 0.0325, 0.0375, 0.0425, 0.0475, 0.0525, 0.0575, 0.0625, 0.0675, 0.0725, 0.0775]
    + [0.0825, 0.0875, 0.0925, 0.10, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19]
    + [0.20, 0.21, 0.22, 0.23, 0.24, 0.25, 0.26, 0.27, 0.28, 0.29, 0.30, 0.31, 0.32, 0.33]
    + [0.34, 0.35, 0.365, 0.385, 0.405, 0.425, 0.445, 0.465, 0.485]
)


def jonswap(f, hs, tp, gamma=3.3):
    fp = 1 / tp
    sig = np.where(f <= fp, 0.07, 0.09)
    shape = (
        f**-5
        * np.exp(-1.25 * (f / fp) ** -4)
        * gamma ** np.exp(-((f / fp - 1) ** 2) / (2 * sig**2))
    )
    df = tf.band_widths(f)
    return shape * (hs / 4) ** 2 / np.sum(shape * df)


def test_one_jonswap_sea_is_one_system_with_the_textbook_ratio():
    e = jonswap(F, 2.0, 8.0)
    out = tf.systems(F, e, tf.band_widths(F))
    assert len(out) == 1
    s = out[0]
    assert abs(s["hs"] - 2.0) < 0.01
    assert abs(s["tp"] - 8.0) < 0.3
    # JONSWAP gamma 3.3 cut at 0.485 Hz: Tp / Tm01 about 1.2
    assert 1.12 < s["tp"] / s["tm01"] < 1.25


def test_swell_and_wind_sea_split_and_label():
    e = jonswap(F, 1.5, 13.0, gamma=7) + jonswap(F, 1.0, 4.5)
    out = tf.systems(F, e, tf.band_widths(F))
    assert len(out) == 2
    got = tf.classify(out, u10=8.0)  # 13 s waves run at 20 m/s: swell; 4.5 s at 7 m/s: wind sea
    assert set(got) == {"ws", "s1"}
    assert abs(got["s1"]["tp"] - 13.0) < 0.8
    assert abs(got["ws"]["tp"] - 4.5) < 0.3
    assert math.isclose(math.hypot(got["s1"]["hs"], got["ws"]["hs"]), 1.8, rel_tol=0.03)


def test_parse_swden():
    text = (
        "#YY  MM DD hh mm  .0200  .0325\n2020 05 01 00 40  0.00  1.25\n2020 05 01 01 40 999.0 2.0\n"
    )
    t, f, e = tf.parse_swden(text)
    assert list(f) == [0.02, 0.0325]
    assert str(t[0]) == "2020-05-01T01"
    assert np.isnan(e[1, 0]) and e[1, 1] == 2.0
