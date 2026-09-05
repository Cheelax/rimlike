import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import {
  ANIMAL_STRIDE,
  BLUEPRINT_STRIDE,
  BUILD_KIND,
  DESIGNATION,
  FACTION,
  FEATURE,
  ITEM_COLORS,
  TERRAIN,
  TERRAIN_COLORS,
  ZONE,
} from "./terrain";

import { PropBatch, PropLibrary, blueprintKey, doorRotation, surfaceTexture, placementTexture, visualSeed, type PropInstance } from "./props";

/** Contrat avec `items::ItemKind` (armes seulement) : gourdin, épieu, arc. */
const WEAPON_KIND = { Club: 6, Spear: 7, Bow: 8 } as const;
/** Position de l'arme tenue, dans le repère local du pawn (main droite). */
const WEAPON_HAND = new THREE.Vector3(0.2, 0.42, 0.06);

const FX_ONE = 256;
export const PAWN_STRIDE = 12;
export const ITEM_STRIDE = 5;
export const PAWN_FLAGS = { MOVING: 1, SLEEPING: 2, WORKING: 4, STARVING: 8, CARRYING: 16, DOWNED: 32 } as const;
/** Caméra à ce niveau de zoom ou plus : les étiquettes de nom deviennent visibles. */
const NAME_LABEL_MIN_ZOOM = 1.6;
/** Contrat avec `sim::Weather` (3 : la pluie qui gèle). */
const WEATHER = { Clear: 0, Rain: 1, Storm: 2, Snow: 3 } as const;
/** Gouttes de pluie instanciées. Purement décoratif : `Math.random` est permis ici. */
const RAIN_DROPS = 600;
/** Demi-largeur de la zone de pluie autour du centre de la vue, en cases. */
const RAIN_SPREAD = 30;
const RAIN_HEIGHT = 12;
const RAIN_SPEED = 14;
const STORM_RAIN_SPEED = 20;
/** Chute de neige : plus lente que la pluie (cases/s). */
const SNOW_SPEED = 4;
/** Couleur des gouttes de pluie, remise en place au dégel. */
const RAIN_COLOR = 0xa8c8ff;
/** Couleur des flocons de neige : blancs plutôt que bleutés. */
const SNOW_COLOR = 0xffffff;
/**
 * Passe le mesh de pluie (une boîte fine 0.02×0.5×0.02) à une taille de
 * flocon ~0.06 par un facteur d'échelle, sans reconstruire la géométrie.
 */
const SNOW_DROP_SCALE = new THREE.Vector3(3, 0.12, 3);
const IDENTITY_QUAT = new THREE.Quaternion();
/** Frames pendant lesquelles un éclair sur-éclaire la scène. */
const FLASH_FRAMES = 2;
/** Teinte vers laquelle le fond tire par mauvais temps. */
const OVERCAST = new THREE.Color(0x2a3038);
/** Mélange du sol vers le blanc quand il neige (60 %, `docs` mission climat). */
const SNOW_GROUND_MIX = 0.6;
/**
 * Bornes d'affichage du mode chaleur, en dixièmes de degré (-30 °C à 40 °C).
 * Exportées pour que la légende du HUD (`App.tsx`) affiche les mêmes bornes
 * que la grille qu'elle légende.
 */
export const HEAT_COLD = -300;
export const HEAT_HOT = 400;

const PAWN_COLORS = [0xa85340, 0x527f98, 0xb59a4e, 0x8c718b, 0x6f8557, 0xb07845];
const SKIN = 0xf1c9a5;
/** Contrat avec `pawn::HP_MAX` (colons et pillards ; les bêtes ont leur propre plafond, hors rendu). */
const PAWN_HP_MAX = 1000;
const RAIDER_COLOR = 0x7a1f1f;
/** Couleur du corps par espèce (`animals::Species` : 0 cerf, 1 lapin, 2 sanglier). */
const ANIMAL_COLORS = [0xc2a878, 0xb0b0b0, 0x3a3128];
/** Couleur des pattes du cerf, plus sombre que le corps. */
const DEER_LEG_COLOR = 0x8a6a4a;
/** Couleur du groin du sanglier. */
const BOAR_SNOUT_COLOR = 0x241c14;
/** Marqueur de chasse : petit cône rouge flottant au-dessus d'une bête marquée gibier. */
const HUNT_MARKER_COLOR = 0xff3030;
/** Largeur de la barre de vie, en cases. */
const HP_BAR_WIDTH = 0.5;
const HP_BAR_EMPTY = new THREE.Color(0xd94f4f);
const HP_BAR_FULL = new THREE.Color(0x6ab04c);
/** Vers quoi la couleur d'un pawn tire quand il est à terre. */
const WHITE = new THREE.Color(0xffffff);

interface PawnView {
  group: THREE.Group;
  carry: THREE.Mesh;
  carryMat: THREE.MeshLambertMaterial;
  zz: THREE.Mesh;
  hpBack: THREE.Mesh;
  hpFill: THREE.Mesh;
  hpMat: THREE.MeshBasicMaterial;
  /** Matériau du corps : sa couleur se pâlit quand le pawn est à terre. */
  bodyMat: THREE.MeshLambertMaterial;
  baseColor: THREE.Color;
  hostile: boolean;
  /** Étiquette de nom, cachée sous le seuil de zoom. */
  nameSprite: THREE.Sprite;
  nameMat: THREE.SpriteMaterial;
  /** Dernier nom peint sur la texture de l'étiquette, pour ne la refaire que si besoin. */
  nameShown: string | null;
  /** Armes tenues en main : une seule visible à la fois, selon `weaponByPawn`. */
  club: THREE.Mesh;
  spear: THREE.Group;
  bow: THREE.Mesh;
  /** Vrai pour une bête (`pawn::Faction::Animal`) : pas d'étiquette de nom, pas de barre de vie flottante. */
  animal: boolean;
  /** Marqueur rouge visible quand la bête est marquée gibier (`animals` buffer). */
  huntMarker: THREE.Mesh;
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
  private readonly placementTexture = placementTexture();
  private readonly placementGrid = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: this.placementTexture, transparent: true, depthWrite: false }),
  );
  private placementActive = false;
  private hoveredTile: TilePos | null = null;
  private readonly pawnRoot = new THREE.Group();
  private readonly pawns = new Map<number, PawnView>();
  private readonly props = new PropLibrary();
  private readonly featureProps = new PropBatch(this.props);
  private readonly floorProps = new PropBatch(this.props);
  private readonly itemProps = new PropBatch(this.props);
  private readonly blueprintProps = new PropBatch(this.props, true);
  private readonly groundTexture = surfaceTexture(true);
  private tileFeatures: Uint8Array = new Uint8Array(0);
  private readonly floorDetails: PropInstance[] = [];
  private readonly rain: THREE.InstancedMesh;
  private readonly rainPos = new Float32Array(RAIN_DROPS * 3);
  private mapMeshes: THREE.Object3D[] = [];
  private overlayMeshes: THREE.Object3D[] = [];
  /** Sol instancié, gardé à part de `mapMeshes` : `updateSnowCover` le recolore sans le reconstruire. */
  private floorMesh: THREE.InstancedMesh | null = null;
  /** Terrain de chaque case (`sim::map::Terrain`), gardé pour recolorer le sol au dégel. */
  private tileTerrain: Uint8Array = new Uint8Array(0);
  /** Dernière couche « intérieur » reçue (0 dehors, sinon numéro de pièce). */
  private indoorCells: Uint8Array = new Uint8Array(0);
  /** Quads d'assombrissement des pièces, reconstruits quand `indoor_version` change. */
  private indoorMeshes: THREE.Object3D[] = [];
  /** Vrai pendant que la météo est Neige : pilote le blanchiment du sol. */
  private snowing = false;
  /** Grille du mode chaleur (touche I), reconstruite à chaque `setHeatData`. */
  private heatMeshes: THREE.Object3D[] = [];
  private heatActive = false;
  /** Nom de chaque pawn vivant, par id (voir `worker/protocol.ts::FrameMessage.names`). */
  private names: Record<number, string> = {};
  /** Arme équipée par id (`frame.weapons`), absent des mains nues. */
  private weaponByPawn = new Map<number, number>();
  /** Espèce et marquage gibier par id (`frame.animals`), absent pour un pawn qui n'est pas une bête. */
  private animalByPawn = new Map<number, { species: number; hunted: boolean }>();
  /** Textures d'étiquette de nom, mises en cache par nom : jamais recréées par frame. */
  private readonly nameTextures = new Map<string, THREE.CanvasTexture>();
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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.placementGrid.visible = false;
    this.scene.add(this.hover, this.selection, this.dragRect, this.placementGrid);

    this.scene.add(this.featureProps.group, this.floorProps.group, this.itemProps.group, this.blueprintProps.group);

    this.rain = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.02, 0.5, 0.02),
      new THREE.MeshBasicMaterial({ color: RAIN_COLOR, transparent: true, opacity: 0.5, depthWrite: false }),
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

  /** (Re)construit les instances uniquement quand la carte change. */
  setMap(width: number, height: number, tiles: Uint8Array, features: Uint8Array): void {
    this.clearMeshes(this.mapMeshes);
    this.clearMeshes(this.indoorMeshes);
    this.clearMeshes(this.heatMeshes);
    this.mapW = width;
    this.mapH = height;
    this.tileTerrain = tiles;
    this.tileFeatures = features;
    this.floorDetails.length = 0;
    const floor = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ map: this.groundTexture }), width * height,
    );
    floor.receiveShadow = true;
    this.floorMesh = floor;
    const entries: PropInstance[] = [];
    const lights: THREE.PointLight[] = [];
    const matrix = new THREE.Matrix4();
    const isWall = (i: number) => features[i] === FEATURE.WallWood || features[i] === FEATURE.WallStone;
    for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
      const i = z * width + x, t = tiles[i], f = features[i];
      const y = t === TERRAIN.DeepWater ? -0.12 : t === TERRAIN.ShallowWater ? -0.06 : 0;
      floor.setMatrixAt(i, matrix.makeTranslation(x + 0.5, y, z + 0.5));
      if (t === TERRAIN.WoodFloor || t === TERRAIN.StoneFloor) this.floorDetails.push({ key: `floor:${t}`, x: x + 0.5, z: z + 0.5 });
      if (f === FEATURE.None) continue;
      const seed = visualSeed(x, z);
      const natural = f <= FEATURE.BushUnripe;
      const isDoor = f === FEATURE.DoorWood || f === FEATURE.DoorStone;
      entries.push({
        key: `feature:${f}`, x: x + 0.5, z: z + 0.5,
        rotation: isDoor ? doorRotation(x, z, width, height, isWall) : natural ? seed % 4 * Math.PI / 2 : 0,
        scale: natural ? 0.9 + seed % 10 / 100 : 1,
        tint: natural ? new THREE.Color().setScalar(0.94 + seed % 7 / 100).getHex() : 0xffffff,
      });
      if (f === FEATURE.Campfire && lights.length < 8) {
        const light = new THREE.PointLight(0xff9a40, 6, 9, 2);
        light.position.set(x + 0.5, 1.1, z + 0.5);
        lights.push(light);
      }
    }
    floor.instanceMatrix.needsUpdate = true;
    this.featureProps.sync(entries);
    this.mapMeshes = [floor, ...lights];
    this.scene.add(...this.mapMeshes);
    this.updateSnowCover();
    if (!this.framed) { this.frame(); this.framed = true; }
  }

  /** Les géométries de catalogue appartiennent à PropLibrary, les overlays à leur couche. */
  private clearMeshes(meshes: THREE.Object3D[]): void {
    for (const object of meshes) {
      this.scene.remove(object);
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
        if (object instanceof THREE.InstancedMesh) object.dispose();
      } else if (object instanceof THREE.Light) object.dispose();
    }
    meshes.length = 0;
  }

  /** Zones de stockage et désignations, en quads translucides. */
  setOverlays(zones: Uint8Array, designations: Uint8Array): void {
    this.clearMeshes(this.overlayMeshes);
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
    build((i) => zones[i] === ZONE.Stockpile, 0x9cacb5, 0.18, 0.012);
    build((i) => zones[i] === ZONE.Growing, 0x57402d, 0.5, 0.012);
    build((i) => designations[i] !== DESIGNATION.None, 0xff9a2e, 0.45, 0.014);
    if (this.overlayMeshes.length) this.scene.add(...this.overlayMeshes);
  }

  /**
   * Couche « intérieur » (`sim-wasm::indoor`, un octet par case : 0 dehors,
   * sinon le numéro de pièce) : un très léger assombrissement de chaque case
   * intérieure, pour qu'on voie « dedans ». Reconstruit à chaque appel, donc
   * seulement quand `indoor_version` change côté Worker — jamais à chaque frame.
   */
  setIndoor(indoor: Uint8Array): void {
    this.indoorCells = indoor;
    this.clearMeshes(this.indoorMeshes);
    let n = 0;
    for (let i = 0; i < indoor.length; i++) if (indoor[i] !== 0) n++;
    if (n > 0) {
      const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.98, 0.98).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.15, depthWrite: false }),
        n,
      );
      const mat = new THREE.Matrix4();
      let k = 0;
      for (let i = 0; i < indoor.length; i++) {
        if (indoor[i] === 0) continue;
        const x = i % this.mapW;
        const y = Math.floor(i / this.mapW);
        mesh.setMatrixAt(k++, mat.makeTranslation(x + 0.5, 0.01, y + 0.5));
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.indoorMeshes = [mesh];
      this.scene.add(mesh);
    }
    // Une pièce qui se ferme ou s'ouvre change ce qui doit rester blanchi.
    this.updateSnowCover();
  }

  /** Vrai si la case `i` (index à plat) est dans une pièce fermée. */
  private isIndoorAt(i: number): boolean {
    return i < this.indoorCells.length && this.indoorCells[i] !== 0;
  }

  /**
   * Recolore le sol instancié : mélangé vers le blanc à 60 % sous la neige,
   * sauf dans les pièces fermées (la neige ne tombe pas dedans). Recolore
   * l'instance existante, ne reconstruit jamais le mesh (`docs` mission climat).
   */
  private updateSnowCover(): void {
    const floor = this.floorMesh;
    if (!floor) return;
    const color = new THREE.Color();
    for (let i = 0; i < this.tileTerrain.length; i++) {
      color.setHex(TERRAIN_COLORS[this.tileTerrain[i]] ?? 0xff00ff);
      const seed = visualSeed(i % this.mapW, Math.floor(i / this.mapW));
      color.multiplyScalar(0.985 + seed % 4 / 100);
      if (this.snowing && !this.isIndoorAt(i)) {
        color.lerp(WHITE, SNOW_GROUND_MIX);
      }
      floor.setColorAt(i, color);
    }
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;
    this.floorProps.sync(this.floorDetails.filter((entry) => !this.snowing || this.isIndoorAt(Math.floor(entry.z) * this.mapW + Math.floor(entry.x))));
  }

  /**
   * Mode d'affichage des températures (touche I, bouton « Chaleur »). Se
   * contente d'activer/désactiver : les couleurs elles-mêmes arrivent par
   * `setHeatData`, qu'il n'appartient pas au Renderer d'aller chercher (le
   * tampon vient d'un `rpc("tileTemperatures")` côté `App.tsx`).
   */
  setHeatMode(active: boolean): void {
    this.heatActive = active;
    if (!active) {
      this.clearMeshes(this.heatMeshes);
    }
  }

  /**
   * Recolore la grille de chaleur depuis un tampon de températures en
   * dixièmes de degré, une valeur par case dans l'ordre `y * largeur + x`
   * (`SimHandle.tileTemperatures`). Sans effet si le mode n'est pas actif :
   * l'appelant n'a pas à s'en soucier avant d'envoyer les données.
   */
  setHeatData(temperatures: Int32Array): void {
    if (!this.heatActive) return;
    this.clearMeshes(this.heatMeshes);
    const n = Math.min(temperatures.length, this.mapW * this.mapH);
    if (n === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.98, 0.98).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      n,
    );
    const mat = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = i % this.mapW;
      const y = Math.floor(i / this.mapW);
      mesh.setMatrixAt(i, mat.makeTranslation(x + 0.5, 0.02, y + 0.5));
      // Bleu froid → rouge chaud : la teinte HSL décroît de 0.62 (bleu) à 0.
      const t = Math.max(0, Math.min(1, (temperatures[i] - HEAT_COLD) / (HEAT_HOT - HEAT_COLD)));
      mesh.setColorAt(i, color.setHSL(0.62 * (1 - t), 0.85, 0.5));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.heatMeshes = [mesh];
    this.scene.add(mesh);
  }

  /** Piles reconnaissables ; la quantité module la taille dans une seule case. */
  syncItems(buf: Int32Array): void {
    const entries: PropInstance[] = [];
    // Plusieurs genres peuvent cohabiter sur une case : les répartir sans les masquer.
    const counts = new Map<string, number>();
    for (let o = 0; o + ITEM_STRIDE <= buf.length; o += ITEM_STRIDE) {
      const cell = `${buf[o + 3]},${buf[o + 4]}`;
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
    const slots = new Map<string, number>();
    for (let o = 0; o + ITEM_STRIDE <= buf.length; o += ITEM_STRIDE) {
      const kind = buf[o + 1], count = buf[o + 2];
      const cell = `${buf[o + 3]},${buf[o + 4]}`;
      const side = Math.ceil(Math.sqrt(counts.get(cell)!));
      const slot = slots.get(cell) ?? 0;
      slots.set(cell, slot + 1);
      entries.push({ key: `item:${kind}`,
        x: buf[o + 3] + (slot % side + 0.5) / side,
        z: buf[o + 4] + (Math.floor(slot / side) + 0.5) / side,
        y: 0.018, scale: (0.66 + 0.34 * Math.min(count, 75) / 75) / side,
      });
    }
    this.itemProps.sync(entries);
  }

  /** Même modèle et orientation que l'objet fini ; bleu livré plus tard, ocre prêt. */
  syncBlueprints(buf: Int32Array): void {
    const entries: PropInstance[] = [];
    const plannedWalls = new Set<number>();
    for (let o = 0; o + BLUEPRINT_STRIDE <= buf.length; o += BLUEPRINT_STRIDE) {
      if (buf[o + 1] === BUILD_KIND.Wall) plannedWalls.add(buf[o + 4] * this.mapW + buf[o + 3]);
    }
    const wallAt = (i: number) => plannedWalls.has(i) || this.tileFeatures[i] === FEATURE.WallWood || this.tileFeatures[i] === FEATURE.WallStone;
    for (let o = 0; o + BLUEPRINT_STRIDE <= buf.length; o += BLUEPRINT_STRIDE) {
      const kind = buf[o + 1], x = buf[o + 3], z = buf[o + 4];
      entries.push({ key: blueprintKey(kind, buf[o + 2]), x: x + 0.5, z: z + 0.5, y: 0.025,
        rotation: kind === BUILD_KIND.Door ? doorRotation(x, z, this.mapW, this.mapH, wallAt) : 0,
        tint: buf[o + 5] >= buf[o + 6] ? 0xe2bf73 : 0x93bfd0,
      });
    }
    this.blueprintProps.sync(entries);
  }

  /** Nom de chaque pawn vivant, par id. Recopié tel quel : `syncPawns` s'en sert au prochain rendu. */
  setNames(names: Record<number, string>): void {
    this.names = names;
  }

  /** Arme de chaque pawn armé, `[id, genre]×n` (`frame.weapons`). `syncPawns` s'en sert au prochain rendu. */
  setWeapons(buf: Int32Array): void {
    this.weaponByPawn.clear();
    for (let o = 0; o + 2 <= buf.length; o += 2) {
      this.weaponByPawn.set(buf[o], buf[o + 1]);
    }
  }

  /**
   * Faune vivante, `[id, espèce, chassée]×n` (`frame.animals`). `syncPawns` et
   * `createPawn` s'en servent : la forme d'une bête dépend de son espèce, son
   * marqueur de chasse de `hunted`. Appelé avant `syncPawns` par `App.tsx`,
   * comme `setWeapons` et `setNames`.
   */
  setAnimals(buf: Int32Array): void {
    this.animalByPawn.clear();
    for (let o = 0; o + ANIMAL_STRIDE <= buf.length; o += ANIMAL_STRIDE) {
      this.animalByPawn.set(buf[o], { species: buf[o + 1], hunted: buf[o + 2] !== 0 });
    }
  }

  /**
   * Texture d'étiquette de nom, mise en cache par nom (et couleur, hostile ou
   * non) : le canvas ne se redessine jamais deux fois pour le même texte.
   */
  private nameTexture(name: string, hostile: boolean): THREE.CanvasTexture {
    const key = hostile ? `r:${name}` : `c:${name}`;
    const cached = this.nameTextures.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 40;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
      ctx.fillStyle = hostile ? "#ff6b6b" : "#ffffff";
      ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    this.nameTextures.set(key, texture);
    return texture;
  }

  /** Météo courante (`sim::Weather`) : pilote la pluie, la neige, les éclairs et la lumière. */
  setWeather(kind: number): void {
    if (kind === this.weather) return;
    // Le premier éclair attend son tour comme les suivants.
    if (kind === WEATHER.Storm) this.nextFlash = 4 + Math.random() * 5;
    const wasSnowing = this.weather === WEATHER.Snow;
    this.weather = kind;
    // Neige : particules blanches, réutilise le système de pluie (couleur et
    // vitesse changées dans `updateWeather`, sans reconstruire le mesh).
    (this.rain.material as THREE.MeshBasicMaterial).color.setHex(kind === WEATHER.Snow ? SNOW_COLOR : RAIN_COLOR);
    this.snowing = kind === WEATHER.Snow;
    if (this.snowing !== wasSnowing) this.updateSnowCover();
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
    const speed = this.weather === WEATHER.Storm ? STORM_RAIN_SPEED : this.weather === WEATHER.Snow ? SNOW_SPEED : RAIN_SPEED;
    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    for (let i = 0; i < RAIN_DROPS; i++) {
      let y = this.rainPos[i * 3 + 1] - speed * dt;
      if (y < 0) {
        // La goutte repart en haut, recentrée sur la vue courante.
        this.respawnDrop(i, RAIN_HEIGHT);
        y = RAIN_HEIGHT;
      } else {
        this.rainPos[i * 3 + 1] = y;
      }
      pos.set(this.rainPos[i * 3], y, this.rainPos[i * 3 + 2]);
      if (this.snowing) {
        // Flocon : la boîte fine de la pluie devient un petit cube ~0.06.
        mat.compose(pos, IDENTITY_QUAT, SNOW_DROP_SCALE);
      } else {
        mat.makeTranslation(pos.x, pos.y, pos.z);
      }
      this.rain.setMatrixAt(i, mat);
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
    this.placementActive = !pans;
    this.updatePlacementGrid();
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
    // Un seul calcul par frame : les étiquettes de nom n'encombrent pas la vue large.
    const showNames = this.camera.zoom >= NAME_LABEL_MIN_ZOOM;
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
        view = this.createPawn(id, cur[o + 10]);
        this.pawns.set(id, view);
      }
      const g = view.group;
      const dx = x - g.position.x;
      const dz = z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) g.rotation.y = Math.atan2(dx, dz);
      g.position.set(x, 0, z);
      const sleeping = (flags & PAWN_FLAGS.SLEEPING) !== 0;
      const downed = (flags & PAWN_FLAGS.DOWNED) !== 0;
      view.zz.visible = sleeping;
      view.zz.position.y = 1.05 + Math.sin(this.clock * 3) * 0.06;
      // À terre comme endormi : couché au sol. Seul le sommeil affiche les « zzz ».
      const lyingDown = sleeping || downed;
      g.rotation.z = lyingDown ? Math.PI / 2 : 0;
      g.position.y = lyingDown ? 0.25 : 0;
      // Teinte plus pâle pour un pawn à terre : on repart toujours de sa couleur d'origine.
      view.bodyMat.color.copy(view.baseColor).lerp(WHITE, downed ? 0.55 : 0);
      const carrying = (flags & PAWN_FLAGS.CARRYING) !== 0;
      view.carry.visible = carrying;
      if (carrying) {
        view.carry.geometry = this.props.geometry(`item:${cur[o + 8]}`);
        view.carry.material = this.props.material;
        view.carry.scale.setScalar(0.5);
      }
      // Arme équipée : un seul mesh visible à la fois, selon le genre porté.
      const weapon = this.weaponByPawn.get(id) ?? -1;
      view.club.visible = weapon === WEAPON_KIND.Club;
      view.spear.visible = weapon === WEAPON_KIND.Spear;
      view.bow.visible = weapon === WEAPON_KIND.Bow;
      // Étiquette de nom : jamais pour une bête (pas de prénom), sinon cachée
      // de loin ou rafraîchie seulement si le nom a changé.
      const name = this.names[id];
      view.nameSprite.visible = !view.animal && showNames && !!name;
      if (!view.animal && name && view.nameShown !== name) {
        view.nameMat.map = this.nameTexture(name, view.hostile);
        view.nameMat.needsUpdate = true;
        view.nameShown = name;
      }
      // Barre de vie : visible seulement quand le pawn est blessé. Pas pour
      // une bête, dont le plafond de PV dépend de l'espèce (`Species::max_hp`),
      // pas de `PAWN_HP_MAX` : le panneau de sélection l'affiche autrement.
      const hp = cur[o + 11];
      const wounded = !view.animal && hp < PAWN_HP_MAX;
      view.hpBack.visible = wounded;
      view.hpFill.visible = wounded;
      if (wounded) {
        const ratio = Math.max(0, Math.min(1, hp / PAWN_HP_MAX));
        view.hpFill.scale.x = Math.max(ratio, 0.001);
        // Le remplissage se vide vers la droite : son bord gauche ne bouge pas.
        view.hpFill.position.x = (-HP_BAR_WIDTH * (1 - ratio)) / 2;
        view.hpMat.color.copy(HP_BAR_EMPTY).lerp(HP_BAR_FULL, ratio);
      }
      // Marqueur de chasse : une bête marquée gibier (`animals` buffer), et
      // elle seule (l'id d'un colon n'y figure jamais).
      view.huntMarker.visible = this.animalByPawn.get(id)?.hunted ?? false;
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

  /** `faction` suit `pawn::Faction` (0 colonie, 1 pillard, 2 bête) : décide de la forme dessinée. */
  private createPawn(id: number, faction: number): PawnView {
    if (faction === FACTION.Animal) return this.createAnimalPawn(id);
    const group = new THREE.Group();
    const hostile = faction === FACTION.Raider;
    const color = hostile ? RAIDER_COLOR : PAWN_COLORS[id % PAWN_COLORS.length];
    const bodyMat = new THREE.MeshLambertMaterial({ color });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.19, 0.34, 8), bodyMat);
    body.position.y = 0.48;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), new THREE.MeshLambertMaterial({ color: SKIN }));
    head.position.y = 0.78;
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.153, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshLambertMaterial({ color: 0x514331 }));
    hair.position.y = 0.8;
    const limbs: THREE.Mesh[] = [];
    for (const x of [-0.085, 0.085]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.3, 0.13), new THREE.MeshLambertMaterial({ color: 0x575447 }));
      leg.position.set(x, 0.15, 0);
      limbs.push(leg);
    }
    for (const x of [-0.2, 0.2]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.28, 6), bodyMat);
      arm.position.set(x, 0.45, 0.03);
      arm.rotation.z = x > 0 ? 0.12 : -0.12;
      limbs.push(arm);
    }
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
    // Étiquette de nom : sa texture arrive plus tard, dès que `syncPawns` connaît le nom.
    const nameMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
    const nameSprite = new THREE.Sprite(nameMat);
    nameSprite.scale.set(1.4, 0.35, 1);
    nameSprite.position.set(0, 1.24, 0);
    nameSprite.visible = false;

    // Armes tenues en main : un mesh par genre, un seul visible à la fois
    // (`syncPawns`). Gourdin : un bâton fin. Épieu : un bâton plus long, avec
    // une pointe. Arc : un tore aplati, tenu de profil.
    const club = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.035, 0.42, 6),
      new THREE.MeshLambertMaterial({ color: ITEM_COLORS[WEAPON_KIND.Club] }),
    );
    club.position.copy(WEAPON_HAND);
    club.rotation.z = Math.PI / 9;
    club.visible = false;

    const spear = new THREE.Group();
    const spearShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.022, 0.62, 6),
      new THREE.MeshLambertMaterial({ color: ITEM_COLORS[WEAPON_KIND.Club] }),
    );
    const spearTip = new THREE.Mesh(
      new THREE.ConeGeometry(0.045, 0.14, 6),
      new THREE.MeshLambertMaterial({ color: ITEM_COLORS[WEAPON_KIND.Spear] }),
    );
    spearTip.position.y = 0.38;
    spear.add(spearShaft, spearTip);
    spear.position.copy(WEAPON_HAND);
    spear.rotation.z = Math.PI / 11;
    spear.visible = false;

    const bow = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.02, 6, 12, Math.PI * 1.4),
      new THREE.MeshLambertMaterial({ color: ITEM_COLORS[WEAPON_KIND.Bow] }),
    );
    bow.scale.z = 0.3;
    bow.position.copy(WEAPON_HAND);
    bow.rotation.y = Math.PI / 2;
    bow.visible = false;

    for (const m of [body, head, nose, hair, ...limbs, carry, club, spearShaft, spearTip, bow]) {
      m.castShadow = true;
      m.userData.pawnId = id;
    }
    // Marqueur de chasse : jamais montré pour un pawn humain (`syncPawns` ne
    // le lit que via `animalByPawn`, toujours vide pour ces id), donc jamais
    // ajouté au groupe — juste un objet détaché pour garder `PawnView` uniforme.
    const huntMarker = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 6), new THREE.MeshBasicMaterial());
    huntMarker.visible = false;
    group.add(body, head, nose, hair, ...limbs, carry, zz, hpBack, hpFill, nameSprite, club, spear, bow);
    this.pawnRoot.add(group);
    return {
      group,
      carry,
      carryMat,
      zz,
      hpBack,
      hpFill,
      hpMat,
      bodyMat,
      baseColor: new THREE.Color(color),
      hostile,
      nameSprite,
      nameMat,
      nameShown: null,
      club,
      spear,
      bow,
      animal: false,
      huntMarker,
    };
  }

  /**
   * Bête : forme propre à l'espèce (`animals` buffer, `setAnimals`), orientée
   * dans le sens du déplacement comme un colon (géré génériquement par
   * `syncPawns`), sans étiquette de nom ; un marqueur rouge la signale
   * marquée gibier. Les accessoires humains (portage, arme, sommeil, nom)
   * existent pour que `PawnView` reste uniforme, mais ne sont jamais ajoutés
   * au groupe : ils ne peuvent donc jamais s'afficher par erreur.
   */
  private createAnimalPawn(id: number): PawnView {
    const species = this.animalByPawn.get(id)?.species ?? 0;
    const group = new THREE.Group();
    const color = ANIMAL_COLORS[species] ?? 0xffffff;
    const bodyMat = new THREE.MeshLambertMaterial({ color });
    const parts: THREE.Object3D[] = [];
    if (species === 1) {
      // Lapin : petite sphère grise, deux oreilles.
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), bodyMat);
      sphere.position.y = 0.18;
      const earGeo = new THREE.CylinderGeometry(0.02, 0.03, 0.18, 6);
      const earL = new THREE.Mesh(earGeo, bodyMat);
      earL.position.set(-0.06, 0.34, 0);
      earL.rotation.x = -0.2;
      const earR = new THREE.Mesh(earGeo, bodyMat);
      earR.position.set(0.06, 0.34, 0);
      earR.rotation.x = -0.2;
      parts.push(sphere, earL, earR);
    } else if (species === 2) {
      // Sanglier : boîte sombre, un groin.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.4), bodyMat);
      box.position.y = 0.225;
      const snout = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.12, 0.14),
        new THREE.MeshLambertMaterial({ color: BOAR_SNOUT_COLOR }),
      );
      snout.position.set(0, 0.2, 0.36);
      parts.push(box, snout);
    } else {
      // Cerf (par défaut) : corps allongé, tête cubique, quatre pattes fines.
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.35), bodyMat);
      box.position.y = 0.35;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), bodyMat);
      head.position.set(0, 0.5, 0.4);
      parts.push(box, head);
      const legMat = new THREE.MeshLambertMaterial({ color: DEER_LEG_COLOR });
      const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.35, 6);
      for (const [lx, lz] of [
        [-0.22, -0.12],
        [0.22, -0.12],
        [-0.22, 0.12],
        [0.22, 0.12],
      ] as const) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.175, lz);
        parts.push(leg);
      }
    }
    const huntMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.16, 6),
      new THREE.MeshBasicMaterial({ color: HUNT_MARKER_COLOR }),
    );
    huntMarker.position.set(0, 0.85, 0);
    huntMarker.visible = false;
    for (const m of parts) {
      (m as THREE.Mesh).castShadow = true;
      m.userData.pawnId = id;
    }
    huntMarker.userData.pawnId = id;
    group.add(...parts, huntMarker);
    this.pawnRoot.add(group);

    // Accessoires humains : jamais ajoutés au groupe (voir la note ci-dessus).
    const carryMat = new THREE.MeshLambertMaterial();
    const carry = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), carryMat);
    carry.visible = false;
    const zz = new THREE.Mesh(new THREE.SphereGeometry(0.01, 4, 4), new THREE.MeshBasicMaterial());
    zz.visible = false;
    const hpBack = new THREE.Mesh(new THREE.BoxGeometry(HP_BAR_WIDTH, 0.06, 0.06), new THREE.MeshBasicMaterial());
    hpBack.visible = false;
    const hpMat = new THREE.MeshBasicMaterial({ color: HP_BAR_FULL.getHex() });
    const hpFill = new THREE.Mesh(new THREE.BoxGeometry(HP_BAR_WIDTH, 0.06, 0.06), hpMat);
    hpFill.visible = false;
    const nameMat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
    const nameSprite = new THREE.Sprite(nameMat);
    nameSprite.visible = false;
    const club = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial());
    club.visible = false;
    const spear = new THREE.Group();
    spear.visible = false;
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial());
    bow.visible = false;

    return {
      group,
      carry,
      carryMat,
      zz,
      hpBack,
      hpFill,
      hpMat,
      bodyMat,
      baseColor: new THREE.Color(color),
      hostile: false,
      nameSprite,
      nameMat,
      nameShown: null,
      club,
      spear,
      bow,
      animal: true,
      huntMarker,
    };
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    this.selection.visible = id !== null;
  }

  setHover(tile: TilePos | null): void {
    this.hoveredTile = tile;
    this.updatePlacementGrid();
    if (!tile) {
      this.hover.visible = false;
      return;
    }
    this.hover.visible = true;
    this.hover.position.set(tile.x + 0.5, 0.02, tile.y + 0.5);
  }

  private updatePlacementGrid(rect?: TileRect): void {
    const tile = this.hoveredTile;
    this.placementGrid.visible = this.placementActive && (tile !== null || rect !== undefined);
    if (!this.placementGrid.visible) return;
    const x0 = Math.max(0, rect ? Math.min(rect.x0, rect.x1) : tile!.x - 3);
    const z0 = Math.max(0, rect ? Math.min(rect.y0, rect.y1) : tile!.y - 3);
    const x1 = Math.min(this.mapW - 1, rect ? Math.max(rect.x0, rect.x1) : tile!.x + 3);
    const z1 = Math.min(this.mapH - 1, rect ? Math.max(rect.y0, rect.y1) : tile!.y + 3);
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    this.placementGrid.scale.set(w, 1, h);
    this.placementGrid.position.set((x0 + x1 + 1) / 2, 0.021, (z0 + z1 + 1) / 2);
    this.placementTexture.repeat.set(w, h);
  }

  /** Rectangle de sélection en cours de tracé, ou `null`. */
  setDragRect(rect: TileRect | null, color = 0xffffff): void {
    this.updatePlacementGrid(rect ?? undefined);
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
    this.sun.intensity = 0.8 + 1.8 * day;
    this.sun.color
      .setHex(0x7f93c9)
      .lerp(new THREE.Color(0xffa860), day)
      .lerp(new THREE.Color(0xfff4e6), high);

    this.sky.intensity = 0.62 + 0.15 * day;
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
    this.clearMeshes(this.mapMeshes);
    this.clearMeshes(this.overlayMeshes);
    this.clearMeshes(this.indoorMeshes);
    this.clearMeshes(this.heatMeshes);
    this.featureProps.dispose();
    this.floorProps.dispose();
    this.itemProps.dispose();
    this.blueprintProps.dispose();
    this.props.dispose();
    this.groundTexture.dispose();
    this.placementTexture.dispose();
    this.placementGrid.geometry.dispose();
    (this.placementGrid.material as THREE.Material).dispose();
    this.renderer.dispose();
    for (const texture of this.nameTextures.values()) texture.dispose();
    this.nameTextures.clear();
  }
}
