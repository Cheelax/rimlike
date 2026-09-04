import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { TERRAIN, TERRAIN_COLORS } from "./terrain";

const FX_ONE = 256;
const PAWN_STRIDE = 4;

const PAWN_COLORS = [0xd94f4f, 0x4f8fd9, 0xe0b040, 0x8f4fd9, 0x3fb08f, 0xd97f2f];
const SKIN = 0xf1c9a5;

interface PawnView {
  group: THREE.Group;
  body: THREE.Mesh;
}

export interface TilePos {
  x: number;
  y: number;
}

/**
 * Vue du dessus pseudo-3D : caméra orthographique inclinée, soleil qui tourne
 * avec l'heure, ombres. Ne connaît que des tampons plats venant du sim.
 */
export class Renderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: MapControls;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.HemisphereLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hover: THREE.Mesh;
  private readonly selection: THREE.Mesh;
  private readonly pawnRoot = new THREE.Group();
  private readonly pawns = new Map<number, PawnView>();
  private mapMeshes: THREE.Object3D[] = [];
  private mapW = 0;
  private mapH = 0;
  private selectedId: number | null = null;
  private azimuth = 0;
  private targetAzimuth = 0;
  private readonly onResize = () => this.resize();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0x0b0f14);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableRotate = false;
    this.controls.screenSpacePanning = false;
    this.controls.minZoom = 0.4;
    this.controls.maxZoom = 8;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null as unknown as THREE.MOUSE };

    this.sky = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a3a, 0.6);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sky, this.sun, this.sun.target, this.pawnRoot);

    this.hover = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.hover.visible = false;
    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.44, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selection.visible = false;
    this.scene.add(this.hover, this.selection);

    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  /** (Re)construit la carte. Instancié : une draw call par type d'objet. */
  setMap(width: number, height: number, tiles: Uint8Array): void {
    for (const m of this.mapMeshes) this.scene.remove(m);
    this.mapMeshes = [];
    this.mapW = width;
    this.mapH = height;

    const floor = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial(),
      width * height,
    );
    floor.receiveShadow = true;

    let rocks = 0;
    let trees = 0;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === TERRAIN.Rock) rocks++;
      else if (tiles[i] === TERRAIN.Tree) trees++;
    }
    const rockMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.7, 1),
      new THREE.MeshLambertMaterial({ color: 0x7a7a7a }),
      Math.max(rocks, 1),
    );
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
      Math.max(trees, 1),
    );
    const canopyMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.38, 1.0, 7),
      new THREE.MeshLambertMaterial({ color: 0x2f7a2f }),
      Math.max(trees, 1),
    );
    for (const m of [rockMesh, trunkMesh, canopyMesh]) m.castShadow = m.receiveShadow = true;

    const mat = new THREE.Matrix4();
    const color = new THREE.Color();
    let ri = 0;
    let ti = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = tiles[i];
        // Léger décrochement des eaux pour marquer la berge.
        const floorY = t === TERRAIN.DeepWater ? -0.12 : t === TERRAIN.ShallowWater ? -0.06 : 0;
        floor.setMatrixAt(i, mat.makeTranslation(x + 0.5, floorY, y + 0.5));
        floor.setColorAt(i, color.setHex(TERRAIN_COLORS[t] ?? 0xff00ff));
        if (t === TERRAIN.Rock) {
          rockMesh.setMatrixAt(ri++, mat.makeTranslation(x + 0.5, 0.35, y + 0.5));
        } else if (t === TERRAIN.Tree) {
          // Petite variation déterministe de position et de taille par case.
          const j = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const ox = ((j % 100) / 100 - 0.5) * 0.3;
          const oz = (((j >>> 8) % 100) / 100 - 0.5) * 0.3;
          const s = 0.85 + ((j >>> 16) % 100) / 300;
          trunkMesh.setMatrixAt(ti, mat.makeTranslation(x + 0.5 + ox, 0.25 * s, y + 0.5 + oz));
          mat.compose(
            new THREE.Vector3(x + 0.5 + ox, 0.5 * s + 0.5 * s, y + 0.5 + oz),
            new THREE.Quaternion(),
            new THREE.Vector3(s, s, s),
          );
          canopyMesh.setMatrixAt(ti++, mat);
        }
      }
    }
    rockMesh.count = rocks;
    trunkMesh.count = trees;
    canopyMesh.count = trees;
    floor.instanceMatrix.needsUpdate = true;
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;
    for (const m of [rockMesh, trunkMesh, canopyMesh]) m.instanceMatrix.needsUpdate = true;

    this.mapMeshes = [floor, rockMesh, trunkMesh, canopyMesh];
    this.scene.add(...this.mapMeshes);
    this.frame();
  }

  /** Place la caméra sur la carte et dimensionne la caméra d'ombre. */
  private frame(): void {
    const cx = this.mapW / 2;
    const cz = this.mapH / 2;
    this.controls.target.set(cx, 0, cz);
    this.applyCameraOrbit();
    this.sun.target.position.set(cx, 0, cz);
    const half = Math.max(this.mapW, this.mapH) * 0.8;
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = Math.max(this.mapW, this.mapH) * 4;
    sc.updateProjectionMatrix();
  }

  private applyCameraOrbit(): void {
    const elevation = THREE.MathUtils.degToRad(55);
    const dist = 400;
    const t = this.controls.target;
    this.camera.position.set(
      t.x + Math.sin(this.azimuth) * Math.cos(elevation) * dist,
      t.y + Math.sin(elevation) * dist,
      t.z + Math.cos(this.azimuth) * Math.cos(elevation) * dist,
    );
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Tourne la vue d'un quart de tour, animé sur quelques frames. */
  rotate(direction: 1 | -1): void {
    this.targetAzimuth += (direction * Math.PI) / 2;
  }

  /**
   * Synchronise les pawns depuis deux instantanés du tampon sim (tick
   * précédent et courant) interpolés par `alpha` dans `[0, 1]`.
   */
  syncPawns(cur: Int32Array, prev: Int32Array | null, alpha: number): void {
    const seen = new Set<number>();
    const count = Math.floor(cur.length / PAWN_STRIDE);
    for (let i = 0; i < count; i++) {
      const o = i * PAWN_STRIDE;
      const id = cur[o];
      seen.add(id);
      let x = cur[o + 1] / FX_ONE;
      let z = cur[o + 2] / FX_ONE;
      const p = this.prevOf(prev, id);
      if (p) {
        x = p.x + (x - p.x) * alpha;
        z = p.z + (z - p.z) * alpha;
      }
      let view = this.pawns.get(id);
      if (!view) {
        view = this.createPawn(id);
        this.pawns.set(id, view);
      }
      const g = view.group;
      const dx = x - g.position.x;
      const dz = z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) g.rotation.y = Math.atan2(dx, dz);
      g.position.set(x, 0, z);
      if (id === this.selectedId) {
        this.selection.visible = true;
        this.selection.position.set(x, 0.03, z);
      }
    }
    for (const [id, view] of this.pawns) {
      if (!seen.has(id)) {
        this.pawnRoot.remove(view.group);
        this.pawns.delete(id);
      }
    }
    if (this.selectedId !== null && !seen.has(this.selectedId)) {
      this.selectedId = null;
      this.selection.visible = false;
    }
  }

  private prevOf(prev: Int32Array | null, id: number): { x: number; z: number } | null {
    if (!prev) return null;
    for (let o = 0; o + PAWN_STRIDE <= prev.length; o += PAWN_STRIDE) {
      if (prev[o] === id) return { x: prev[o + 1] / FX_ONE, z: prev[o + 2] / FX_ONE };
    }
    return null;
  }

  private createPawn(id: number): PawnView {
    const group = new THREE.Group();
    const color = PAWN_COLORS[id % PAWN_COLORS.length];
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.2, 0.32, 4, 10),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = 0.4;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), new THREE.MeshLambertMaterial({ color: SKIN }));
    head.position.y = 0.78;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.08), new THREE.MeshLambertMaterial({ color: SKIN }));
    nose.position.set(0, 0.76, 0.16);
    for (const m of [body, head, nose]) {
      m.castShadow = true;
      m.userData.pawnId = id;
    }
    group.add(body, head, nose);
    this.pawnRoot.add(group);
    return { group, body };
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    this.selection.visible = id !== null;
  }

  setHover(tile: TilePos | null): void {
    if (!tile) {
      this.hover.visible = false;
      return;
    }
    this.hover.visible = true;
    this.hover.position.set(tile.x + 0.5, 0.02, tile.y + 0.5);
  }

  /** Case du sol sous le curseur, ou `null` hors carte. */
  pickTile(clientX: number, clientY: number): TilePos | null {
    this.setRayFrom(clientX, clientY);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    const x = Math.floor(hit.x);
    const y = Math.floor(hit.z);
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return null;
    return { x, y };
  }

  /** Id du pawn sous le curseur, ou `null`. */
  pickPawn(clientX: number, clientY: number): number | null {
    this.setRayFrom(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.pawnRoot.children, true);
    for (const h of hits) {
      const id = h.object.userData.pawnId;
      if (typeof id === "number") return id;
    }
    return null;
  }

  private setRayFrom(clientX: number, clientY: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** `t` dans `[0, 1)` : 0 minuit, 0.25 lever, 0.5 midi, 0.75 coucher. */
  setTimeOfDay(t: number): void {
    const phi = (t - 0.25) * Math.PI * 2;
    const el = Math.sin(phi);
    const cx = this.mapW / 2;
    const cz = this.mapH / 2;
    const R = Math.max(this.mapW, this.mapH) * 1.5;
    this.sun.position.set(cx - Math.cos(phi) * R, Math.max(el, 0.03) * R, cz + 0.45 * R);

    const day = THREE.MathUtils.smoothstep(el, -0.08, 0.3);
    const high = THREE.MathUtils.smoothstep(el, 0.0, 0.6);
    this.sun.intensity = 2.6 * day;
    this.sun.color.setHex(0xffa860).lerp(new THREE.Color(0xfff4e6), high);
    this.sun.castShadow = day > 0.02;

    this.sky.intensity = 0.12 + 0.6 * day;
    this.sky.color.setHex(0x223a70).lerp(new THREE.Color(0xbfd4ff), day);
    this.sky.groundColor.setHex(0x101820).lerp(new THREE.Color(0x6b5a3a), day);
    (this.scene.background as THREE.Color).setHex(0x04060a).lerp(new THREE.Color(0x0b0f14), day);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const viewHeight = 48; // cases visibles verticalement au zoom 1
    const aspect = w / h;
    this.camera.left = (-viewHeight * aspect) / 2;
    this.camera.right = (viewHeight * aspect) / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    if (Math.abs(this.targetAzimuth - this.azimuth) > 1e-4) {
      this.azimuth += (this.targetAzimuth - this.azimuth) * 0.18;
      if (Math.abs(this.targetAzimuth - this.azimuth) < 1e-3) this.azimuth = this.targetAzimuth;
      this.applyCameraOrbit();
    } else {
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
