// The one way a page loads a .glb model. The build compresses the models' geometry with Draco
// (scripts/draco_models.mjs; a kayak is 0.2 MB to fetch instead of 0.8), so the loader needs
// three's Draco decoder, which the build puts beside the pages in ./draco/. The decoder (75 kB)
// is fetched once, the first time a compressed model arrives, and runs off the main thread.
// A model that isn't compressed (a dev server, a host's hand-made copy) loads as before.
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

let draco: DRACOLoader | null = null;

/** A model loader that reads compressed and plain models alike. */
export function gltfLoader(): GLTFLoader {
  draco ??= new DRACOLoader().setDecoderPath(new URL("./draco/", document.baseURI).href);
  return new GLTFLoader().setDRACOLoader(draco);
}
