// The Bluewater wordmark, direction C "Horizon" (Iris; Elena's pick, 12 Nov 2026). Fraunces, SIL OFL
// (public/fonts/Fraunces-OFL.txt). The top bar adds these rules to every page, so the title can use
// the full mark too. Markup is constant: MARK_SMALL in the top bar, MARK_FULL (with the sun) on the title.
export const MARK_SMALL = `<span class="bw-mark bw-small" aria-label="Bluewater"><span class="bw-a">Blue</span><span class="bw-b">water</span><span class="bw-h"></span></span>`;
export const MARK_FULL = `<span class="bw-mark" aria-label="Bluewater"><span class="bw-a">Blue</span><span class="bw-b">water</span><span class="bw-h"></span><span class="bw-sun"></span></span>`;

export const WORDMARK_CSS = `
@font-face { font-family: "Fraunces"; src: url("./fonts/fraunces-latin-full-normal.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
.bw-mark { position: relative; display: inline-block; font-family: "Fraunces", Georgia, serif; line-height: 1; letter-spacing: -0.01em; white-space: nowrap; }
.bw-a { font-weight: 300; font-variation-settings: "SOFT" 50, "opsz" 144; }
.bw-b { font-weight: 850; font-variation-settings: "SOFT" 50, "opsz" 144; }
.bw-h { position: absolute; left: 0; right: -0.76em; top: 84%; height: 0.016em; min-height: 1px; background: currentColor; opacity: 0.6; }
.bw-sun { position: absolute; width: 0.42em; height: 0.21em; border-radius: 0.42em 0.42em 0 0; background: var(--orange, #ff8a2a); right: -0.66em; top: calc(84% - 0.21em); }
.bw-small .bw-sun { display: none; }
.bw-small .bw-h { right: 0; opacity: 0.7; }
.bw-small .bw-a { font-weight: 440; font-variation-settings: "SOFT" 50, "opsz" 24; }
.bw-small .bw-b { font-variation-settings: "SOFT" 50, "opsz" 24; }
.bw-on-photo { text-shadow: 0 1px 14px rgba(0, 25, 50, 0.38); }
.bw-heading { font-family: "Fraunces", Georgia, serif; font-weight: 800; font-variation-settings: "SOFT" 50; text-transform: uppercase; letter-spacing: 0.09em; }
`;
