"""Charts for the title-sound review (Hana): a spectrogram per clip with each sound labelled,
loudness over time, and a table of how loud each effect is against the sea under it. Reads the
WAVs and levels.json written by tools/title-sound-render.mjs.
    python3 tools/title-sound-report.py <dir>
"""

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.io import wavfile
from scipy.signal import spectrogram

d = Path(sys.argv[1] if len(sys.argv) > 1 else "title-sound-review")
levels = json.loads((d / "levels.json").read_text())


def load(name):
    rate, x = wavfile.read(d / f"{name}.wav")
    return rate, x.astype(np.float64) / 32768


def db(v):
    return 20 * np.log10(max(v, 1e-9))


# 1. A spectrogram per clip (0 to 5 kHz), each sound labelled where it played.
for name, info in levels.items():
    rate, x = load(name)
    f, t, s = spectrogram(x, rate, nperseg=2048, noverlap=1536)
    fig, ax = plt.subplots(figsize=(13, 4.6), dpi=110)
    keep = f <= 5000
    ax.pcolormesh(
        t,
        f[keep],
        10 * np.log10(s[keep] + 1e-14),
        vmin=-125,
        vmax=-60,
        cmap="magma",
        shading="auto",
    )
    ax.axhline(2000, color="w", lw=0.8, ls="--")
    ax.text(0.3, 2060, "2 kHz: nothing tonal above this line", color="w", fontsize=8)
    marks = (
        [(m[0], m[1]) for m in info["moments"]]
        if info.get("moments")
        else [(p["t"], p["name"]) for p in info["played"]]
    )
    for at, what in marks:
        ax.axvline(at, color="c", lw=0.6, alpha=0.7)
        ax.text(at + 0.15, 4600, what, color="c", fontsize=8, rotation=90, va="top")
    ax.set_xlabel("seconds")
    ax.set_ylabel("Hz")
    ax.set_title(f"{name}: what's in the sound over time (brighter = louder)")
    fig.tight_layout()
    fig.savefig(d / f"{name}-spectrogram.png")
    plt.close(fig)

# 2. Loudness over time, every clip.
fig, ax = plt.subplots(figsize=(11, 4.5), dpi=110)
for name, info in levels.items():
    r = info["rms"]
    ax.plot(np.arange(len(r)) * 0.5, r, label=name, lw=1.3)
ax.set_xlabel("seconds")
ax.set_ylabel("loudness, dB full scale (RMS, half-second windows)")
ax.set_title("Title sound: loudness over time")
ax.legend(fontsize=8)
ax.grid(alpha=0.3)
fig.tight_layout()
fig.savefig(d / "loudness.png")
plt.close(fig)

# 3. Each effect on its own: the each-sound clip minus the sea-only clip (same seed, so the sea
#    under them is the same) leaves the effects alone, near enough (the limiter moves a hair).
#    Whether anything tonal sits above 2 kHz is read off the spectrograms, not from here.
if "title-each-sound" in levels and "title-sea-only" in levels:
    rate, a = load("title-each-sound")
    _, b = load("title-sea-only")
    n = min(len(a), len(b))
    fx = a[:n] - b[:n]
    sea = b[:n]
    rows = []
    for at, what in levels["title-each-sound"]["moments"]:
        i0, i1 = int(at * rate), min(n, int((at + 2.5) * rate))
        seg, segsea = fx[i0:i1], sea[i0:i1]
        w = int(0.05 * rate)  # loudest 50 ms of the effect
        e = np.convolve(seg**2, np.ones(w) / w, "valid")
        loud = np.sqrt(e.max())
        rows.append((at, what, db(np.abs(seg).max()), db(loud), db(np.sqrt(np.mean(segsea**2)))))
    lines = ["time s | sound    | peak dBFS | loudest 50 ms dBFS | sea under it dBFS"]
    for at, what, pk, ld, sd in rows:
        lines.append(f"{at:6.1f} | {what:8s} | {pk:9.1f} | {ld:18.1f} | {sd:17.1f}")
    (d / "effects.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
