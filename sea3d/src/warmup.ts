import * as THREE from "three";

const V4 = THREE.Vector4;

/** Builds a page's off-screen shaders (a pass drawn into its own picture): returns the materials it built. */
export type Warm = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => Iterable<THREE.Material>;

type Program = { isReady(): boolean; getUniforms(): unknown };

/**
 * Start a page's drawing only once its shaders are built (Omar's speed list, 14 Nov 2026: every
 * page froze for 2 to 7 s just after it opened, while the first frame built its shaders in one go
 * and waited for each; the cloud's alone took most of a second). The page paints first; then the
 * shaders are all handed to the graphics driver at once, and waited for between tasks, so the page
 * stays responsive: with KHR_parallel_shader_compile (most browsers) by asking whether each is
 * ready, which never blocks, and without it one shader's wait per task. The drawing starts when
 * they're all built, or after `maxMs` at the most. `extras` build passes the scene doesn't hold.
 */
export function startWhenBuilt(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  start: () => void,
  extras: Warm[] = [],
  /** The picture the scene is drawn into (the atmosphere's post-processing target), which the shaders are built for. */
  target: () => THREE.WebGLRenderTarget | null = () => null,
  maxMs = 8000,
): void {
  let started = false;
  const go = (): void => {
    if (started) return;
    started = true;
    start();
  };
  const parallel = !!renderer.getContext().getExtension("KHR_parallel_shader_compile");
  // Every program built for each material: one material can have several (the screen, the reflection).
  const programs = (m: THREE.Material): Program[] => [...((renderer.properties.get(m) as { programs?: Map<string, Program> }).programs?.values() ?? [])];
  // After the first paint: a frame, then a task.
  requestAnimationFrame(() =>
    setTimeout(() => {
      setTimeout(go, maxMs);
      let built: THREE.Material[] = [];
      const prev = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(target());
        built = [...renderer.compile(scene, camera)];
        for (const w of extras) built.push(...w(renderer, scene, camera));
      } catch {
        return go();
      } finally {
        renderer.setRenderTarget(prev);
      }
      let left = [...new Set(built.flatMap(programs))];
      const next = (): void => {
        if (started) return;
        if (parallel) {
          left = left.filter((p) => !p.isReady());
          if (!left.length) return draw();
          setTimeout(next, 10);
          return;
        }
        const p = left.shift();
        if (!p) return draw();
        try {
          p.getUniforms(); // waits for this one shader only
        } catch {
          /* the first frame builds it instead */
        }
        setTimeout(next, 0);
      };
      // Then draw each visible thing once, a few per task (drawEach).
      const things: THREE.Object3D[] = [];
      scene.traverseVisible((o) => {
        if (drawable(o)) things.push(o);
      });
      let at = 0;
      const draw = (): void => {
        if (started) return;
        at = drawEach(renderer, scene, camera, things, target(), at);
        if (at >= things.length) return go();
        setTimeout(draw, 0);
      };
      next();
    }, 0),
  );
}

const drawable = (o: THREE.Object3D): boolean =>
  !!((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite);
const px = new Uint8Array(4);

/**
 * Draw each of these things once, alone, into a 2-pixel corner of the picture `target` (null: the
 * screen), from `from` on, for about `budgetMs`: a graphics driver still sets each shader up for
 * drawing on its first use (in software graphics most of a page's start-up freeze, 1 to 3 s in one
 * task). A pixel read back after each draw makes it finish there, so its cost lands in this task.
 * Things hidden, or inside something hidden, are drawn too (shown just for their draw). Returns
 * where to carry on.
 */
export function drawEach(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  things: THREE.Object3D[],
  target: THREE.WebGLRenderTarget | null,
  from = 0,
  budgetMs = 30,
): number {
  const t0 = performance.now();
  const gl = renderer.getContext();
  const prevT = renderer.getRenderTarget();
  const prevShadow = renderer.shadowMap.autoUpdate;
  const vp = renderer.getViewport(new V4()), sc = renderer.getScissor(new V4()), test = renderer.getScissorTest();
  const tSc = target?.scissor.clone(), tTest = target?.scissorTest;
  const saved = new Map<THREE.Object3D, boolean>();
  const show = (o: THREE.Object3D, v: boolean): void => {
    if (!saved.has(o)) saved.set(o, o.visible);
    o.visible = v;
  };
  let at = from;
  try {
    if (target) {
      target.scissor.set(0, 0, 2, 2); // a target draws to its own scissor, not the renderer's
      target.scissorTest = true;
    }
    renderer.shadowMap.autoUpdate = false;
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, 2, 2);
    scene.traverse((o) => {
      if (drawable(o)) show(o, false);
    });
    while (at < things.length && (at === from || performance.now() - t0 < budgetMs)) {
      const o = things[at++];
      let root = o;
      while (root.parent) root = root.parent;
      if (root !== scene) continue; // not (or no longer) in the scene
      const opened: THREE.Object3D[] = [];
      for (let q: THREE.Object3D | null = o; q && q !== scene; q = q.parent)
        if (!q.visible || q === o) {
          show(q, true);
          opened.push(q);
        }
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      for (const q of opened) q.visible = false;
      renderer.setRenderTarget(null); // the screen's 8-bit pixel reads back the same everywhere
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
  } catch {
    at = things.length;
  } finally {
    for (const [o, v] of saved) o.visible = v;
    if (target) {
      target.scissor.copy(tSc!);
      target.scissorTest = tTest!;
    }
    renderer.setScissor(sc);
    renderer.setViewport(vp);
    renderer.setScissorTest(test);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevT);
  }
  return at;
}

/** Build the scene's shaders for another picture it is drawn into too (the calm-water reflection). */
export const intoTarget =
  (target: () => THREE.WebGLRenderTarget): Warm =>
  (renderer, scene, camera) => {
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target());
      return renderer.compile(scene, camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
  };

/**
 * Add something to a running page's scene once its own shaders are built, so its first frame
 * doesn't build them (a graphics card takes a quarter of a second or more per shader there, and the
 * picture stops meanwhile). Its materials are built as the scene's (its fog and lights) for the
 * picture `target` it will be drawn into; with KHR_parallel_shader_compile the driver builds them
 * off this thread and the page waits between frames, without it they are added at once as before.
 * Added after `maxMs` at the latest. Only its own materials: the scene's are built already.
 */
export function addWhenBuilt(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  thing: THREE.Object3D,
  target: () => THREE.WebGLRenderTarget | null = () => null,
  maxMs = 10000,
): Promise<void> {
  const t0 = performance.now();
  const add = (): void => {
    if (!thing.parent) scene.add(thing);
  };
  if (!renderer.getContext().getExtension("KHR_parallel_shader_compile")) {
    add();
    return Promise.resolve();
  }
  const programs = (m: THREE.Material): Program[] => [...((renderer.properties.get(m) as { programs?: Map<string, Program> }).programs?.values() ?? [])];
  let left: Program[] = [];
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target());
    // Its hidden parts are left out (taken out of their parents' lists for the call, no events): the
    // page may never show them, and built here they'd be shaders nobody sees (the company's bow
    // waves on the title, speed guard).
    const out: [THREE.Object3D[], number, THREE.Object3D][] = [];
    thing.traverse((o) => {
      if (o.visible || !o.parent || o === thing) return;
      const list = o.parent.children;
      const i = list.indexOf(o);
      out.push([list, i, o]);
    });
    try {
      for (let j = out.length - 1; j >= 0; j--) out[j][0].splice(out[j][1], 1);
      left = [...new Set([...renderer.compile(thing, camera, scene)].flatMap(programs))];
    } finally {
      for (const [list, i, o] of out) list.splice(i, 0, o);
    }
  } catch {
    add();
    return Promise.resolve();
  } finally {
    renderer.setRenderTarget(prev);
  }
  return new Promise((done) => {
    const wait = (): void => {
      left = left.filter((p) => !p.isReady());
      if (!left.length || performance.now() - t0 > maxMs) {
        add();
        return done();
      }
      setTimeout(wait, 20);
    };
    wait();
  });
}
