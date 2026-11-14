/**
 * The Bay Bridge and the real buoys round the title's spot (John, 14 Nov 2026: "Is it supposed to
 * be the golden hour in Annapolis?" and, on the card, "Sunrise over the Bay Bridge"). From
 * Annapolis Roads the bridge stands 6.6 km off at 64 degrees true, towards the sunrise: the
 * classic Annapolis dawn (titleShore.ts SHORE says which sunrise, and why).
 *
 * They are the practice course's own (land/bayBridge.ts, land/seamarks.ts), placed at their true
 * bearings and turned with the skyline (titleShore.ts), so that the true sunrise falls where the
 * title draws its sun. The title's sea ends at 3 km, so the whole set is drawn about 0.3 times as far
 * off and as big, which looks the same from the boat: every angle is kept.
 *
 * Their lights are on as at dawn: the bridge's road lamps and red tower lights, and the lighted
 * buoys' flashes, half as bright as after dark (Elena: never brighter than the town's).
 */
import * as THREE from "three";
import { BayBridge } from "./land/bayBridge";
import { Seamarks } from "./land/seamarks";
import { SHORE, SHORE_REACH, shoreTurn } from "./titleShore";

/** How much nearer (and smaller) the set is drawn: the bridge's far end, about 8.6 km off, comes inside the skyline's reach. */
export const LANDMARK_SCALE = SHORE_REACH / 8600;
/** The sun's height the lights are lit for (deg): a little before sunrise, so they are half on. */
export const DAWN_LIGHTS_EL = -1;

export class TitleLandmarks {
  readonly root = new THREE.Group();
  private readonly bridge = new BayBridge();
  private readonly marks = new Seamarks();

  /** sunAz: the compass bearing the title draws its sun at. */
  constructor(sunAz: number) {
    this.root.name = "title-landmarks";
    this.root.rotation.y = THREE.MathUtils.degToRad(shoreTurn(sunAz));
    this.root.scale.setScalar(LANDMARK_SCALE);
    this.root.add(this.bridge.root, this.marks.root);
    this.bridge.update(SHORE.lat, SHORE.lon, DAWN_LIGHTS_EL);
  }

  /** Each frame: the buoys' lights flash in their own rhythms. */
  update(t: number): void {
    this.marks.update(SHORE.lat, SHORE.lon, t, DAWN_LIGHTS_EL);
  }

  dispose(): void {
    this.bridge.dispose();
    this.marks.dispose();
  }
}
