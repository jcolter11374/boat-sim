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
      // Then draw each visible thing once, into a 2-pixel corner of the picture, a few per task: a
      // graphics driver still sets each shader up for drawing on its first use (in software
      // graphics that was most of the freeze left, 1 to 3 s, in one task at the first frame).
      // Reading a pixel back after each draw makes it finish there, so its cost is its own task's.
      const things: THREE.Object3D[] = [];
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) things.push(o);
      });
      const shown = things.map((o) => o.visible);
      const gl = renderer.getContext();
      let at = 0;
      const px = new Uint8Array(4);
      const draw = (): void => {
        if (started) return;
        const t0 = performance.now();
        const prevT = renderer.getRenderTarget();
        const prevShadow = renderer.shadowMap.autoUpdate;
        const vp = renderer.getViewport(new V4()), sc = renderer.getScissor(new V4()), test = renderer.getScissorTest();
        const t = target();
        const tSc = t?.scissor.clone(), tTest = t?.scissorTest;
        try {
          if (t) {
            t.scissor.set(0, 0, 2, 2); // a target draws to its own scissor, not the renderer's
            t.scissorTest = true;
          }
          renderer.setRenderTarget(t);
          renderer.shadowMap.autoUpdate = false;
          renderer.setScissorTest(true);
          renderer.setScissor(0, 0, 2, 2);
          for (const o of things) o.visible = false;
          while (at < things.length && performance.now() - t0 < 30) {
            const o = things[at++];
            o.visible = true;
            renderer.render(scene, camera);
            o.visible = false;
            renderer.setRenderTarget(null); // the screen's 8-bit pixel reads back the same everywhere
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            renderer.setRenderTarget(t);
          }
        } catch {
          at = things.length;
        } finally {
          things.forEach((o, i) => (o.visible = shown[i]));
          if (t) {
            t.scissor.copy(tSc!);
            t.scissorTest = tTest!;
          }
          renderer.setScissor(sc);
          renderer.setViewport(vp);
          renderer.setScissorTest(test);
          renderer.shadowMap.autoUpdate = prevShadow;
          renderer.setRenderTarget(prevT);
        }
        if (at >= things.length) return go();
        setTimeout(draw, 0);
      };
      next();
    }, 0),
  );
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
