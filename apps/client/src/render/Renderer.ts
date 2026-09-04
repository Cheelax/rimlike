import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import {
  BLUEPRINT_STRIDE,
  BUILD_KIND,
  DESIGNATION,
  DOOR_COLORS,
  FEATURE,
  ITEM_COLORS,
  TERRAIN,
  TERRAIN_COLORS,
  WALL_COLORS,
  ZONE,
} from "./terrain";

const FX_ONE = 256;
export const PAWN_STRIDE = 12;
export const ITEM_STRIDE = 5;
export const PAWN_FLAGS = { MOVING: 1, SLEEPING: 2, WORKING: 4, STARVING: 8, CARRYING: 16 } as const;
const MAX_ITEMS = 2048;
/** `ItemKind::Corpse` côté sim. */
const ITEM_CORPSE = 5;
const MAX_BLUEPRINTS = 2048;

/** Contrat avec `sim::Weather`. */
const WEATHER = { Clear: 0, Rain: 1, Storm: 2 } as const;
/** Gouttes de pluie instanciées. Purement décoratif : `Math.random` est permis ici. */
const RAIN_DROPS = 600;
/** Demi-largeur de la zone de pluie autour du centre de la vue, en cases. */
const RAIN_SPREAD = 30;
const RAIN_HEIGHT = 12;
const RAIN_SPEED = 14;
const STORM_RAIN_SPEED = 20;
/** Frames pendant lesquelles un éclair sur-éclaire la scène. */
const FLASH_FRAMES = 2;
/** Teinte vers laquelle le fond tire par mauvais temps. */
const OVERCAST = new THREE.Color(0x2a3038);

const PAWN_COLORS = [0xd94f4f, 0x4f8fd9, 0xe0b040, 0x8f4fd9, 0x3fb08f, 0xd97f2f];
const SKIN = 0xf1c9a5;
/** Contrat avec `pawn::Faction` et `pawn::HP_MAX`. */
const FACTION_RAIDER = 1;
const PAWN_HP_MAX = 1000;
const RAIDER_COLOR = 0x7a1f1f;
/** Largeur de la barre de vie, en cases. */
const HP_BAR_WIDTH = 0.5;
const HP_BAR_EMPTY = new THREE.Color(0xd94f4f);
const HP_BAR_FULL = new THREE.Color(0x6ab04c);

interface PawnView {
  group: THREE.Group;
  carry: THREE.Mesh;
  carryMat: THREE.MeshLambertMaterial;
  zz: THREE.Mesh;
  hpBack: THREE.Mesh;
  hpFill: THREE.Mesh;
  hpMat: THREE.MeshBasicMaterial;
}

export interface TilePos {
  x: number;
  y: number;
}

export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
  private readonly dragRect: THREE.Mesh;
  private readonly pawnRoot = new THREE.Group();
  private readonly pawns = new Map<number, PawnView>();
  private readonly items: THREE.InstancedMesh;
  private readonly blueprints: THREE.InstancedMesh;
  private readonly rain: THREE.InstancedMesh;
  private readonly rainPos = new Float32Array(RAIN_DROPS * 3);
  private mapMeshes: THREE.Object3D[] = [];
  private overlayMeshes: THREE.Object3D[] = [];
  private mapW = 0;
  private mapH = 0;
  private framed = false;
  private selectedId: number | null = null;
  private azimuth = 0;
  private targetAzimuth = 0;
  private clock = 0;
  private weather: number = WEATHER.Clear;
  /** Frames d'éclair restantes, et délai avant le suivant en secondes. */
  private flashFrames = 0;
  private nextFlash = 0;
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
    this.controls.listenToKeyEvents(window); // flèches : déplacement
    this.controls.keyPanSpeed = 24;
    this.setLeftDragPans(true);

    this.sky = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a3a, 0.6);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sky, this.sun, this.sun.target, this.pawnRoot);

    const flat = () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.hover = new THREE.Mesh(
      flat(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.hover.visible = false;
    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.44, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selection.visible = false;
    this.dragRect = new THREE.Mesh(
      flat(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.dragRect.visible = false;
    this.scene.add(this.hover, this.selection, this.dragRect);

    this.items = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      MAX_ITEMS,
    );
    this.items.count = 0;
    this.items.castShadow = true;
    this.scene.add(this.items);

    this.blueprints = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthWrite: false }),
      MAX_BLUEPRINTS,
    );
    this.blueprints.count = 0;
    this.scene.add(this.blueprints);

    this.rain = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.02, 0.5, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xa8c8ff, transparent: true, opacity: 0.5, depthWrite: false }),
      RAIN_DROPS,
    );
    this.rain.castShadow = false;
    this.rain.receiveShadow = false;
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
    this.seedRain();

    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  /** (Re)construit sol et éléments. Instancié : une draw call par type d'objet. */
  setMap(width: number, height: number, tiles: Uint8Array, features: Uint8Array): void {
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
    let bushes = 0;
    let walls = 0;
    let doors = 0;
    let beds = 0;
    let crops = 0;
    let ripe = 0;
    let fires = 0;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (f === FEATURE.Rock) rocks++;
      else if (f === FEATURE.Tree) trees++;
      else if (f === FEATURE.Bush || f === FEATURE.BushUnripe) bushes++;
      else if (f === FEATURE.WallWood || f === FEATURE.WallStone) walls++;
      else if (f === FEATURE.DoorWood || f === FEATURE.DoorStone) doors++;
      else if (f === FEATURE.Bed) beds++;
      else if (f === FEATURE.Crop) crops++;
      else if (f === FEATURE.CropRipe) ripe++;
      else if (f === FEATURE.Campfire) fires++;
    }
    const isWall = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      const f = features[y * width + x];
      return f === FEATURE.WallWood || f === FEATURE.WallStone;
    };
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
    const bushMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.32, 8, 6),
      new THREE.MeshLambertMaterial(),
      Math.max(bushes, 1),
    );
    const wallMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      Math.max(walls, 1),
    );
    const doorMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.95, 0.3),
      new THREE.MeshLambertMaterial(),
      Math.max(doors, 1),
    );
    const bedFrame = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.9, 0.22, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
      Math.max(beds, 1),
    );
    const bedMattress = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.78, 0.12, 0.7),
      new THREE.MeshLambertMaterial({ color: 0xe6dcc8 }),
      Math.max(beds, 1),
    );
    const bedPillow = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 0.1, 0.18),
      new THREE.MeshLambertMaterial({ color: 0xf6f6f6 }),
      Math.max(beds, 1),
    );
    const cropMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.16, 0.36, 5),
      new THREE.MeshLambertMaterial({ color: 0x3f9a3f }),
      Math.max(crops, 1),
    );
    const ripeMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.27, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0x9acd32 }),
      Math.max(ripe, 1),
    );
    const fireRing = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.42, 0.46, 0.16, 8),
      new THREE.MeshLambertMaterial({ color: 0x4a4a4a }),
      Math.max(fires, 1),
    );
    const flame = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.17, 0.45, 6),
      new THREE.MeshBasicMaterial({ color: 0xff8a2a }),
      Math.max(fires, 1),
    );
    const lights: THREE.Object3D[] = [];
    for (const m of [rockMesh, trunkMesh, canopyMesh, bushMesh, wallMesh, doorMesh, bedFrame, bedMattress, bedPillow, cropMesh, ripeMesh, fireRing]) {
      m.castShadow = m.receiveShadow = true;
    }

    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    let ri = 0;
    let ti = 0;
    let bi = 0;
    let wi = 0;
    let di = 0;
    let li = 0;
    let ci = 0;
    let pi = 0;
    let fi = 0;
    const yRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = tiles[i];
        const f = features[i];
        const floorY = t === TERRAIN.DeepWater ? -0.12 : t === TERRAIN.ShallowWater ? -0.06 : 0;
        floor.setMatrixAt(i, mat.makeTranslation(x + 0.5, floorY, y + 0.5));
        floor.setColorAt(i, color.setHex(TERRAIN_COLORS[t] ?? 0xff00ff));
        const j = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const ox = ((j % 100) / 100 - 0.5) * 0.3;
        const oz = (((j >>> 8) % 100) / 100 - 0.5) * 0.3;
        const s = 0.85 + ((j >>> 16) % 100) / 300;
        if (f === FEATURE.Rock) {
          rockMesh.setMatrixAt(ri++, mat.makeTranslation(x + 0.5, 0.35, y + 0.5));
        } else if (f === FEATURE.Tree) {
          trunkMesh.setMatrixAt(ti, mat.makeTranslation(x + 0.5 + ox, 0.25 * s, y + 0.5 + oz));
          mat.compose(pos.set(x + 0.5 + ox, s, y + 0.5 + oz), q, scl.set(s, s, s));
          canopyMesh.setMatrixAt(ti++, mat);
        } else if (f === FEATURE.Bush || f === FEATURE.BushUnripe) {
          mat.compose(pos.set(x + 0.5 + ox, 0.2 * s, y + 0.5 + oz), q, scl.set(s, 0.7 * s, s));
          bushMesh.setMatrixAt(bi, mat);
          bushMesh.setColorAt(bi++, color.setHex(f === FEATURE.Bush ? 0x3a7d2a : 0x7c8a55));
        } else if (f === FEATURE.WallWood || f === FEATURE.WallStone) {
          wallMesh.setMatrixAt(wi, mat.makeTranslation(x + 0.5, 0.5, y + 0.5));
          wallMesh.setColorAt(wi++, color.setHex(WALL_COLORS[f === FEATURE.WallWood ? 0 : 1]));
        } else if (f === FEATURE.DoorWood || f === FEATURE.DoorStone) {
          // La porte s'aligne sur les murs voisins : fine dans l'axe du passage.
          const alongX = isWall(x - 1, y) || isWall(x + 1, y);
          mat.compose(pos.set(x + 0.5, 0.475, y + 0.5), alongX ? q : yRot, scl.set(1, 1, 1));
          doorMesh.setMatrixAt(di, mat);
          doorMesh.setColorAt(di++, color.setHex(DOOR_COLORS[f === FEATURE.DoorWood ? 0 : 1]));
        } else if (f === FEATURE.Bed) {
          bedFrame.setMatrixAt(li, mat.makeTranslation(x + 0.5, 0.11, y + 0.5));
          bedMattress.setMatrixAt(li, mat.makeTranslation(x + 0.5, 0.28, y + 0.55));
          bedPillow.setMatrixAt(li++, mat.makeTranslation(x + 0.5, 0.36, y + 0.2));
        } else if (f === FEATURE.Crop) {
          cropMesh.setMatrixAt(ci++, mat.makeTranslation(x + 0.5 + ox * 0.5, 0.18, y + 0.5 + oz * 0.5));
        } else if (f === FEATURE.CropRipe) {
          ripeMesh.setMatrixAt(pi++, mat.makeTranslation(x + 0.5 + ox * 0.5, 0.27, y + 0.5 + oz * 0.5));
        } else if (f === FEATURE.Campfire) {
          fireRing.setMatrixAt(fi, mat.makeTranslation(x + 0.5, 0.08, y + 0.5));
          flame.setMatrixAt(fi++, mat.makeTranslation(x + 0.5, 0.38, y + 0.5));
          if (lights.length < 8) {
            const light = new THREE.PointLight(0xff9a40, 6, 9, 2);
            light.position.set(x + 0.5, 1.1, y + 0.5);
            lights.push(light);
          }
        }
      }
    }
    rockMesh.count = rocks;
    trunkMesh.count = trees;
    canopyMesh.count = trees;
    bushMesh.count = bushes;
    wallMesh.count = walls;
    doorMesh.count = doors;
    bedFrame.count = beds;
    bedMattress.count = beds;
    bedPillow.count = beds;
    cropMesh.count = crops;
    ripeMesh.count = ripe;
    fireRing.count = fires;
    flame.count = fires;
    floor.instanceMatrix.needsUpdate = true;
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;
    for (const m of [bushMesh, wallMesh, doorMesh]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    const featureMeshes = [rockMesh, trunkMesh, canopyMesh, bushMesh, wallMesh, doorMesh, bedFrame, bedMattress, bedPillow, cropMesh, ripeMesh, fireRing, flame];
    for (const m of featureMeshes) m.instanceMatrix.needsUpdate = true;

    this.mapMeshes = [floor, ...featureMeshes, ...lights];
    this.scene.add(...this.mapMeshes);
    if (!this.framed) {
      this.frame();
      this.framed = true;
    }
  }

  /** Zones de stockage et désignations, en quads translucides. */
  setOverlays(zones: Uint8Array, designations: Uint8Array): void {
    for (const m of this.overlayMeshes) this.scene.remove(m);
    this.overlayMeshes = [];
    const build = (pick: (i: number) => boolean, color: number, opacity: number, y: number) => {
      let n = 0;
      for (let i = 0; i < zones.length; i++) if (pick(i)) n++;
      if (n === 0) return;
      const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
        n,
      );
      const mat = new THREE.Matrix4();
      let k = 0;
      for (let i = 0; i < zones.length; i++) {
        if (!pick(i)) continue;
        const x = i % this.mapW;
        const yy = Math.floor(i / this.mapW);
        mesh.setMatrixAt(k++, mat.makeTranslation(x + 0.5, y, yy + 0.5));
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.overlayMeshes.push(mesh);
    };
    build((i) => zones[i] === ZONE.Stockpile, 0x4a90d9, 0.3, 0.012);
    build((i) => zones[i] === ZONE.Growing, 0x5cc25c, 0.3, 0.012);
    build((i) => designations[i] !== DESIGNATION.None, 0xff9a2e, 0.45, 0.014);
    if (this.overlayMeshes.length) this.scene.add(...this.overlayMeshes);
  }

  /** Piles d'objets au sol : cubes colorés par genre, taille selon la quantité. */
  syncItems(buf: Int32Array): void {
    const n = Math.min(Math.floor(buf.length / ITEM_STRIDE), MAX_ITEMS);
    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const o = i * ITEM_STRIDE;
      const kind = buf[o + 1];
      const count = buf[o + 2];
      if (kind === ITEM_CORPSE) {
        // Un corps allongé, pas une caisse.
        mat.compose(pos.set(buf[o + 3] + 0.5, 0.09, buf[o + 4] + 0.5), q, scl.set(0.85, 0.18, 0.42));
      } else {
        const s = 0.22 + 0.3 * Math.min(count, 75) / 75;
        mat.compose(pos.set(buf[o + 3] + 0.5, s * 0.35 + 0.01, buf[o + 4] + 0.5), q, scl.set(s, s * 0.7, s));
      }
      this.items.setMatrixAt(i, mat);
      this.items.setColorAt(i, color.setHex(ITEM_COLORS[kind] ?? 0xff00ff));
    }
    this.items.count = n;
    this.items.instanceMatrix.needsUpdate = true;
    if (this.items.instanceColor) this.items.instanceColor.needsUpdate = true;
  }

  /** Chantiers en fantômes translucides : bleu en attente de matériaux, jaune prêt à bâtir. */
  syncBlueprints(buf: Int32Array): void {
    const n = Math.min(Math.floor(buf.length / BLUEPRINT_STRIDE), MAX_BLUEPRINTS);
    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const o = i * BLUEPRINT_STRIDE;
      const kind = buf[o + 1];
      const x = buf[o + 3] + 0.5;
      const z = buf[o + 4] + 0.5;
      const ready = buf[o + 5] >= buf[o + 6];
      switch (kind) {
        case BUILD_KIND.Wall:
          mat.compose(pos.set(x, 0.5, z), q, scl.set(0.96, 1, 0.96));
          break;
        case BUILD_KIND.Door:
          mat.compose(pos.set(x, 0.475, z), q, scl.set(0.96, 0.95, 0.3));
          break;
        case BUILD_KIND.Bed:
          mat.compose(pos.set(x, 0.15, z), q, scl.set(0.9, 0.3, 0.9));
          break;
        default:
          mat.compose(pos.set(x, 0.03, z), q, scl.set(0.96, 0.06, 0.96));
      }
      this.blueprints.setMatrixAt(i, mat);
      this.blueprints.setColorAt(i, color.setHex(ready ? 0xffe066 : 0x4ad9ff));
    }
    this.blueprints.count = n;
    this.blueprints.instanceMatrix.needsUpdate = true;
    if (this.blueprints.instanceColor) this.blueprints.instanceColor.needsUpdate = true;
  }

  /** Météo courante (`sim::Weather`) : pilote la pluie, les éclairs et la lumière. */
  setWeather(kind: number): void {
    if (kind === this.weather) return;
    // Le premier éclair attend son tour comme les suivants.
    if (kind === WEATHER.Storm) this.nextFlash = 4 + Math.random() * 5;
    this.weather = kind;
  }

  /** Répartit les gouttes autour du centre de la vue, à des hauteurs variées. */
  private seedRain(): void {
    for (let i = 0; i < RAIN_DROPS; i++) this.respawnDrop(i, Math.random() * RAIN_HEIGHT);
  }

  private respawnDrop(i: number, y: number): void {
    const t = this.controls.target;
    this.rainPos[i * 3] = t.x + (Math.random() * 2 - 1) * RAIN_SPREAD;
    this.rainPos[i * 3 + 1] = y;
    this.rainPos[i * 3 + 2] = t.z + (Math.random() * 2 - 1) * RAIN_SPREAD;
  }

  /**
   * Fait tomber la pluie et lâche un éclair de temps en temps sous l'orage.
   * Purement décoratif : l'aléa du rendu n'entre jamais dans le sim.
   */
  private updateWeather(dt: number): void {
    const wet = this.weather !== WEATHER.Clear;
    this.rain.visible = wet;
    if (!wet) {
      this.flashFrames = 0;
      this.nextFlash = 0;
      return;
    }
    const speed = this.weather === WEATHER.Storm ? STORM_RAIN_SPEED : RAIN_SPEED;
    const mat = new THREE.Matrix4();
    for (let i = 0; i < RAIN_DROPS; i++) {
      let y = this.rainPos[i * 3 + 1] - speed * dt;
      if (y < 0) {
        // La goutte repart en haut, recentrée sur la vue courante.
        this.respawnDrop(i, RAIN_HEIGHT);
        y = RAIN_HEIGHT;
      } else {
        this.rainPos[i * 3 + 1] = y;
      }
      this.rain.setMatrixAt(i, mat.makeTranslation(this.rainPos[i * 3], y, this.rainPos[i * 3 + 2]));
    }
    this.rain.instanceMatrix.needsUpdate = true;
    if (this.weather !== WEATHER.Storm) return;
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.flashFrames = FLASH_FRAMES;
      this.nextFlash = 4 + Math.random() * 5;
    }
    if (this.flashFrames > 0) {
      this.flashFrames--;
      this.sun.intensity *= 6;
    }
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

  /**
   * Glisser gauche : déplacement de la caméra en mode sélection, tracé de
   * rectangle quand un outil est actif. Le glisser droit déplace toujours.
   */
  setLeftDragPans(pans: boolean): void {
    this.controls.mouseButtons = {
      LEFT: pans ? THREE.MOUSE.PAN : (null as unknown as THREE.MOUSE),
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
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
      const flags = cur[o + 3];
      const p = this.prevOf(prev, id);
      if (p) {
        x = p.x + (x - p.x) * alpha;
        z = p.z + (z - p.z) * alpha;
      }
      let view = this.pawns.get(id);
      if (!view) {
        view = this.createPawn(id, cur[o + 10] === FACTION_RAIDER);
        this.pawns.set(id, view);
      }
      const g = view.group;
      const dx = x - g.position.x;
      const dz = z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) g.rotation.y = Math.atan2(dx, dz);
      g.position.set(x, 0, z);
      const sleeping = (flags & PAWN_FLAGS.SLEEPING) !== 0;
      view.zz.visible = sleeping;
      view.zz.position.y = 1.05 + Math.sin(this.clock * 3) * 0.06;
      g.rotation.z = sleeping ? Math.PI / 2 : 0;
      g.position.y = sleeping ? 0.25 : 0;
      const carrying = (flags & PAWN_FLAGS.CARRYING) !== 0;
      view.carry.visible = carrying;
      if (carrying) view.carryMat.color.setHex(ITEM_COLORS[cur[o + 8]] ?? 0xffffff);
      // Barre de vie : visible seulement quand le pawn est blessé.
      const hp = cur[o + 11];
      const wounded = hp < PAWN_HP_MAX;
      view.hpBack.visible = wounded;
      view.hpFill.visible = wounded;
      if (wounded) {
        const ratio = Math.max(0, Math.min(1, hp / PAWN_HP_MAX));
        view.hpFill.scale.x = Math.max(ratio, 0.001);
        // Le remplissage se vide vers la droite : son bord gauche ne bouge pas.
        view.hpFill.position.x = (-HP_BAR_WIDTH * (1 - ratio)) / 2;
        view.hpMat.color.copy(HP_BAR_EMPTY).lerp(HP_BAR_FULL, ratio);
      }
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

  private createPawn(id: number, hostile: boolean): PawnView {
    const group = new THREE.Group();
    const color = hostile ? RAIDER_COLOR : PAWN_COLORS[id % PAWN_COLORS.length];
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.32, 4, 10), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.4;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), new THREE.MeshLambertMaterial({ color: SKIN }));
    head.position.y = 0.78;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.08), new THREE.MeshLambertMaterial({ color: SKIN }));
    nose.position.set(0, 0.76, 0.16);
    const carryMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const carry = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.22), carryMat);
    carry.position.set(0, 0.42, 0.3);
    carry.visible = false;
    const zz = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x9ad0ff }),
    );
    zz.position.set(0.15, 1.05, 0);
    zz.visible = false;
    const hpBack = new THREE.Mesh(
      new THREE.BoxGeometry(HP_BAR_WIDTH, 0.06, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x14181e }),
    );
    hpBack.position.set(0, 1.02, 0);
    hpBack.visible = false;
    const hpMat = new THREE.MeshBasicMaterial({ color: HP_BAR_FULL.getHex() });
    const hpFill = new THREE.Mesh(new THREE.BoxGeometry(HP_BAR_WIDTH, 0.06, 0.06), hpMat);
    // Un cheveu au-dessus du fond : pas de faces coplanaires qui scintillent.
    hpFill.position.set(0, 1.03, 0);
    hpFill.visible = false;
    for (const m of [body, head, nose, carry]) {
      m.castShadow = true;
      m.userData.pawnId = id;
    }
    group.add(body, head, nose, carry, zz, hpBack, hpFill);
    this.pawnRoot.add(group);
    return { group, carry, carryMat, zz, hpBack, hpFill, hpMat };
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

  /** Rectangle de sélection en cours de tracé, ou `null`. */
  setDragRect(rect: TileRect | null, color = 0xffffff): void {
    if (!rect) {
      this.dragRect.visible = false;
      return;
    }
    const x0 = Math.min(rect.x0, rect.x1);
    const x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1);
    const y1 = Math.max(rect.y0, rect.y1);
    this.dragRect.visible = true;
    (this.dragRect.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.dragRect.scale.set(x1 - x0 + 1, 1, y1 - y0 + 1);
    this.dragRect.position.set((x0 + x1 + 1) / 2, 0.025, (y0 + y1 + 1) / 2);
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
    const day = THREE.MathUtils.smoothstep(el, -0.08, 0.3);
    const high = THREE.MathUtils.smoothstep(el, 0.0, 0.6);
    // La nuit, la lumière directionnelle devient une lune haute et bleutée :
    // la scène reste lisible et garde ses ombres.
    const lightEl = THREE.MathUtils.lerp(0.6, Math.max(el, 0.03), day);
    this.sun.position.set(cx - Math.cos(phi) * R, lightEl * R, cz + 0.45 * R);
    this.sun.intensity = 0.55 + 2.05 * day;
    this.sun.color
      .setHex(0x7f93c9)
      .lerp(new THREE.Color(0xffa860), day)
      .lerp(new THREE.Color(0xfff4e6), high);

    this.sky.intensity = 0.42 + 0.35 * day;
    this.sky.color.setHex(0x55679a).lerp(new THREE.Color(0xbfd4ff), day);
    this.sky.groundColor.setHex(0x2b3140).lerp(new THREE.Color(0x6b5a3a), day);
    (this.scene.background as THREE.Color).setHex(0x06080e).lerp(new THREE.Color(0x0b0f14), day);

    // Le mauvais temps assombrit et grise tout, l'orage plus encore.
    if (this.weather !== WEATHER.Clear) {
      const storm = this.weather === WEATHER.Storm;
      this.sun.intensity *= storm ? 0.4 : 0.6;
      this.sky.intensity *= storm ? 0.6 : 0.75;
      (this.scene.background as THREE.Color).lerp(OVERCAST, storm ? 0.5 : 0.35);
    }
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

  render(dtSeconds: number): void {
    this.clock += dtSeconds;
    this.updateWeather(dtSeconds);
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
