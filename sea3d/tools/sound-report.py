"""Charts for the sea-sound review (Felix, Sound): loudness over time per scenario, the
loudness-by-force climb, and a spectrogram strip per clip. Reads the WAVs and levels.json
written by tools/sound-render.mjs.
    python3 tools/sound-report.py <dir>
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

d = Path(sys.argv[1] if len(sys.argv) > 1 else "sound-review")
levels = json.loads((d / "levels.json").read_text())
names = list(levels)

# 1. Loudness over 60 s, every scenario.
fig, ax = plt.subplots(figsize=(11, 5.5), dpi=110)
for n in names:
    r = levels[n]["rms"]
    ax.plot(np.arange(len(r)) * 0.5, r, label=n, lw=1.4)
ax.set_xlabel("seconds")
ax.set_ylabel("loudness, dB full scale (RMS, half-second windows)")
ax.set_title("Sea sound: loudness over a minute, by scenario")
ax.grid(alpha=0.3)
ax.legend(fontsize=8, ncol=2, loc="lower right")
fig.tight_layout()
fig.savefig(d / "loudness-over-time.png")

# 2. The climb by force (Pearson clips): mean, and the range from quietest to loudest moment.
forces, mean, lo, hi = [], [], [], []
for n in names:
    if n.endswith("-pearson"):
        r = np.array(levels[n]["rms"][4:])  # skip the first 2 s while the beds fade in
        forces.append(int(n[5 : n.index("-")]))
        mean.append(10 * np.log10(np.mean(10 ** (r / 10))))
        lo.append(np.percentile(r, 5))
        hi.append(np.percentile(r, 95))
fig, ax = plt.subplots(figsize=(8, 4.8), dpi=110)
ax.fill_between(forces, lo, hi, alpha=0.25, label="quietest to loudest moments (5-95%)")
ax.plot(forces, mean, "o-", lw=2, label="average")
for f, m in zip(forces, mean):
    ax.annotate(f"{m:.0f}", (f, m), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=9)
ax.set_xlabel("wind force (Beaufort: 1 near calm, 4 good sailing breeze, 8 gale)")
ax.set_ylabel("dB full scale")
ax.set_title("Loudness climbs with the wind (Pearson 31, sailing)")
ax.grid(alpha=0.3)
ax.legend(fontsize=9)
fig.tight_layout()
fig.savefig(d / "loudness-by-force.png")

# 3. Spectrograms, one strip per clip, 0-8 kHz.
fig, axs = plt.subplots(len(names), 1, figsize=(11, 1.55 * len(names)), dpi=100, sharex=True)
for ax, n in zip(axs, names):
    rate, x = wavfile.read(d / f"{n}.wav")
    f, t, s = spectrogram(x.astype(np.float32) / 32768, fs=rate, nperseg=2048, noverlap=1024)
    keep = f <= 8000
    ax.pcolormesh(t, f[keep] / 1000, 10 * np.log10(s[keep] + 1e-14), vmin=-130, vmax=-50, shading="auto", cmap="magma")
    ax.set_ylabel("kHz", fontsize=7)
    ax.text(0.5, 6.6, n, color="white", fontsize=8, va="top")
    ax.tick_params(labelsize=7)
axs[-1].set_xlabel("seconds")
fig.suptitle("Spectrograms (brighter = louder; nothing tonal should sit high up)", fontsize=10)
fig.tight_layout()
fig.savefig(d / "spectrograms.png")
print("wrote", d / "loudness-over-time.png", d / "loudness-by-force.png", d / "spectrograms.png")
