/**
 * Le globe en Three.js : une sphère de cases hexagonales colorées par biome,
 * qu'on tourne et qu'on zoome pour choisir où s'installer.
 *
 * Indépendant de `Renderer.ts` (la carte de colonie) : rien n'est partagé, ni
 * la scène, ni la caméra, ni le canevas. Ce module ne décide rien non plus —
 * il reçoit un `World` et une liste de colonies, il rend et il répond « quelle
 * case sous ce pixel ». Toute la géométrie vient de `globeGeometry.ts`, pur et
 * testé.
 *
 * Structure de la scène :
 * - une `BufferGeometry` unique pour les 4 N − 12 triangles du globe, couleur
 *   plate par case (un seul appel de dessin) ;
 * - une sphère intérieure opaque, juste sous le niveau de la mer, qui bouche
 *   les fentes ouvertes par le relief entre deux cases de hauteurs
 *   différentes ;
 * - trois calques légers redessinés à la demande : survol, sélection,
 *   colonies ;
 * - les caravanes : une polyligne discrète par itinéraire, un cône par convoi
 *   posé sur sa case courante, et la prévisualisation de l'itinéraire en
 *   préparation, elle bien visible ;
 * - un fond d'étoiles en `Points`, purement décoratif.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Caravan, Settlement } from "@rimlike/protocol";
import type { World } from "@rimlike/world";
import { GLOBE_RADIUS, RELIEF_SCALE, buildGlobeGeometry, buildTileFan, tileRadius } from "./globeGeometry";

/** Distance caméra ↔ centre au premier affichage. */
const START_DISTANCE = 2.9;
const MIN_DISTANCE = 1.25;
const MAX_DISTANCE = 6;
/** Les calques flottent juste au-dessus du sol pour ne pas cligner avec lui. */
const OVERLAY_LIFT = 1.002;
/** Hauteur du marqueur de colonie au-dessus de sa case. */
const MARKER_LIFT = 0.035;
const MARKER_SIZE = 0.014;
const STAR_COUNT = 1400;
const STAR_RADIUS = 40;

/** Couleur d'une colonie : la nôtre en jaune, celles des autres en orange. */
const OWN_COLONY = 0xffe066;
const OTHER_COLONY = 0xff8a4a;

/** Hauteur du marqueur d'une caravane au-dessus de sa case, et sa taille. */
const CARAVAN_LIFT = 0.026;
const CARAVAN_SIZE = 0.011;
/** Les itinéraires flottent un peu plus haut que les calques de case. */
const ROUTE_LIFT = 1.008;
/** L'itinéraire en préparation passe au-dessus de ceux qui voyagent déjà. */
const PREVIEW_LIFT = 1.016;
/** Rayon de saisie d'un marqueur de caravane, en pixels d'écran. */
const CARAVAN_PICK_PX = 16;

/**
 * Couleur d'une caravane suivant son statut (`docs/protocol.md` §12.2). Une
 * caravane livrée n'est plus dessinée : elle reste listée dans le panneau
 * pendant `CARAVAN_HISTORY_HOURS`, mais elle n'est plus nulle part sur le
 * globe.
 */
const CARAVAN_COLORS: Readonly<Record<string, number>> = {
  travelling: 0xffb347,
  returning: 0xff8f8f,
  arrived: 0x7fd8ff,
  delivered: 0x8a8f96,
};

export interface GlobeRendererOptions {
  /** Rappel appelé quand la case survolée change (y compris vers `null`). */
  readonly onHover?: (tile: number | null) => void;
  /** Rappel appelé quand la caravane survolée change (y compris vers `null`). */
  readonly onHoverCaravan?: (id: string | null) => void;
}

export class GlobeRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly globe: THREE.Mesh;
  private readonly tileOfTriangle: Uint32Array;
  private readonly hoverMesh: THREE.Mesh;
  private readonly selectionMesh: THREE.Mesh;
  private readonly colonyMesh: THREE.Mesh;
  private readonly markerRoot = new THREE.Group();
  private readonly markerGeometry = new THREE.OctahedronGeometry(MARKER_SIZE, 0);
  private readonly ownMarkerMaterial: THREE.MeshBasicMaterial;
  private readonly otherMarkerMaterial: THREE.MeshBasicMaterial;
  /** Cônes des caravanes en vol, un enfant par convoi (`userData.caravanId`). */
  private readonly caravanRoot = new THREE.Group();
  private readonly caravanGeometry = new THREE.ConeGeometry(CARAVAN_SIZE, CARAVAN_SIZE * 3, 5);
  private readonly caravanMaterials = new Map<string, THREE.MeshBasicMaterial>();
  /** Itinéraires des caravanes, toutes en une seule polyligne segmentée. */
  private readonly routeLines: THREE.LineSegments;
  /** Itinéraire en préparation, plus haut et plus vif que les autres. */
  private readonly previewLine: THREE.LineSegments;
  private readonly onHover: ((tile: number | null) => void) | null;
  private readonly onHoverCaravan: ((id: string | null) => void) | null;
  private readonly onResize = () => this.resize();

  private hoverTile: number | null = null;
  private hoverCaravan: string | null = null;
  private selectedTile: number | null = null;
  /** Dernière position du curseur, en pixels client. Le survol est résolu à la frame. */
  private pointer: { x: number; y: number } | null = null;
  private pointerDirty = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: World,
    options: GlobeRendererOptions = {},
  ) {
    this.onHover = options.onHover ?? null;
    this.onHoverCaravan = options.onHoverCaravan ?? null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x05070c);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    this.camera.position.set(0, 0.6, START_DISTANCE);

    this.controls = new OrbitControls(this.camera, canvas);
    // Rotation et zoom seulement : sur un globe, déplacer la cible n'a pas de sens.
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;

    // Un soleil fixe (la lumière ne suit pas la caméra) : le terminateur défile
    // quand on tourne le globe, ce qui donne tout de suite sa forme sphérique.
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.1);
    sun.position.set(3.5, 2.2, 4);
    const sky = new THREE.HemisphereLight(0x8fb0ff, 0x0a0f18, 0.75);
    this.scene.add(sun, sky, this.markerRoot);

    const { positions, colors, tileOfTriangle } = buildGlobeGeometry(world);
    this.tileOfTriangle = tileOfTriangle;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Géométrie non indexée : les normales calculées sont celles des faces,
    // ce qui donne exactement le facettage voulu.
    geometry.computeVertexNormals();
    this.globe = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.scene.add(this.globe);

    // Sphère de garde : sans elle, les marches du relief laissent voir les
    // étoiles entre deux cases voisines de hauteurs différentes.
    const filler = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * (1 - RELIEF_SCALE), 64, 48),
      new THREE.MeshBasicMaterial({ color: 0x0a1b2c }),
    );
    this.scene.add(filler);

    this.hoverMesh = overlayMesh(0xffffff, 0.3);
    this.selectionMesh = overlayMesh(0x4ad9ff, 0.45);
    // Les colonies partagent un calque : leur couleur est portée par les
    // sommets (la nôtre ou celle d'un autre) plutôt que par le matériau.
    this.colonyMesh = overlayMesh(0xffffff, 0.55, true);
    this.scene.add(this.hoverMesh, this.selectionMesh, this.colonyMesh);

    this.ownMarkerMaterial = new THREE.MeshBasicMaterial({ color: OWN_COLONY });
    this.otherMarkerMaterial = new THREE.MeshBasicMaterial({ color: OTHER_COLONY });

    // Les itinéraires en vol restent discrets : ce sont des indications, pas
    // l'information principale. La prévisualisation, elle, est ce que le
    // joueur est en train de décider.
    this.routeLines = routeMesh(0.5, true);
    this.previewLine = routeMesh(0.95, false, 0x4ad9ff);
    this.scene.add(this.caravanRoot, this.routeLines, this.previewLine);

    this.scene.add(starfield());

    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  // --- Entrées ---

  /**
   * Position du curseur, en pixels client. Le survol n'est **pas** résolu ici :
   * un raycast par mouvement de souris coûterait 40 000 tests de triangle. Il
   * l'est au plus une fois par frame, dans `render`.
   */
  setPointer(clientX: number, clientY: number): void {
    this.pointer = { x: clientX, y: clientY };
    this.pointerDirty = true;
  }

  clearPointer(): void {
    this.pointer = null;
    this.pointerDirty = true;
  }

  /** Case sous un pixel, tout de suite (un clic ne peut pas attendre la frame). */
  pickAt(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.globe, false)[0];
    const face = hit?.faceIndex;
    if (face === undefined || face === null || face >= this.tileOfTriangle.length) return null;
    // Géométrie non indexée : `faceIndex` est l'indice du triangle, donc
    // exactement l'indice de `tileOfTriangle`.
    return this.tileOfTriangle[face];
  }

  // --- Affichage ---

  setSelected(tile: number | null): void {
    if (this.selectedTile === tile) return;
    this.selectedTile = tile;
    this.applyFan(this.selectionMesh, tile);
  }

  /**
   * Recolore les cases colonisées et repositionne leurs marqueurs.
   *
   * `myKey` est notre clé publique et stable (`docs/protocol.md` §11.2),
   * `null` tant qu'on ne la connaît pas encore : `Settlement.owner` est
   * toujours une clé, jamais un nom, l'appartenance ne se compare qu'à elle.
   */
  setSettlements(settlements: readonly Settlement[], myKey: string | null): void {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const marker of this.markerRoot.children.slice()) {
      this.markerRoot.remove(marker);
    }
    for (const settlement of settlements) {
      if (!this.hasTile(settlement.tile)) continue;
      const tile = this.world.tiles[settlement.tile];
      const own = settlement.owner === myKey;
      const hex = own ? OWN_COLONY : OTHER_COLONY;
      const rgb = new THREE.Color(hex).convertSRGBToLinear();
      const fan = buildTileFan(tile, GLOBE_RADIUS * OVERLAY_LIFT);
      for (let i = 0; i < fan.length; i += 3) {
        positions.push(fan[i]!, fan[i + 1]!, fan[i + 2]!);
        colors.push(rgb.r, rgb.g, rgb.b);
      }
      const marker = new THREE.Mesh(this.markerGeometry, own ? this.ownMarkerMaterial : this.otherMarkerMaterial);
      const height = tileRadius(tile) + MARKER_LIFT;
      marker.position.set(tile.center[0] * height, tile.center[1] * height, tile.center[2] * height);
      this.markerRoot.add(marker);
    }
    const geometry = this.colonyMesh.geometry;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    this.colonyMesh.visible = positions.length > 0;
  }

  /**
   * Redessine les caravanes : un cône par convoi sur sa case courante, une
   * polyligne par itinéraire. Les caravanes `delivered` ne sont plus
   * dessinées — elles ne sont plus nulle part sur le globe, seulement dans
   * l'historique du panneau.
   *
   * `myKey` (notre clé publique et stable, `docs/protocol.md` §11.2) n'entre
   * pas dans la couleur (le statut suffit à lire la scène) mais les nôtres
   * sont un peu plus grosses : c'est ce qu'on cherche des yeux. `null` tant
   * qu'on ne connaît pas encore notre clé.
   */
  setCaravans(caravans: readonly Caravan[], myKey: string | null): void {
    for (const marker of this.caravanRoot.children.slice()) {
      this.caravanRoot.remove(marker);
    }
    const segments: number[] = [];
    const colors: number[] = [];
    for (const caravan of caravans) {
      if (caravan.status === "delivered") continue;
      const hex = CARAVAN_COLORS[caravan.status] ?? OTHER_COLONY;
      const rgb = new THREE.Color(hex).convertSRGBToLinear();
      this.pushRoute(caravan.route, GLOBE_RADIUS * ROUTE_LIFT, segments, colors, rgb);
      if (!this.hasTile(caravan.currentTile)) continue;
      const tile = this.world.tiles[caravan.currentTile];
      const marker = new THREE.Mesh(this.caravanGeometry, this.caravanMaterial(caravan.status));
      const height = tileRadius(tile) + CARAVAN_LIFT;
      const up = new THREE.Vector3(tile.center[0], tile.center[1], tile.center[2]).normalize();
      marker.position.copy(up).multiplyScalar(height);
      // Le cône pointe vers le ciel de sa case : sinon il coucherait dans
      // l'axe Y de la scène, qui n'a aucun sens sur une sphère.
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      if (caravan.owner === myKey) marker.scale.setScalar(1.35);
      marker.userData.caravanId = caravan.id;
      this.caravanRoot.add(marker);
    }
    applySegments(this.routeLines, segments, colors);
  }

  /**
   * Itinéraire en préparation, ou `null` pour l'effacer. Le client le calcule
   * lui-même par `findRoute` : c'est une prévisualisation, le serveur a le
   * dernier mot sur la route qui voyagera (`docs/world.md` §5).
   */
  setRoutePreview(route: readonly number[] | null): void {
    const segments: number[] = [];
    const colors: number[] = [];
    if (route !== null) {
      const rgb = new THREE.Color(0x4ad9ff).convertSRGBToLinear();
      this.pushRoute(route, GLOBE_RADIUS * PREVIEW_LIFT, segments, colors, rgb);
    }
    applySegments(this.previewLine, segments, colors);
  }

  /**
   * Caravane sous un pixel, ou `null`. La saisie se fait **à l'écran** plutôt
   * qu'au raycast : un cône de 2 % de rayon est trop petit pour être visé à la
   * souris, et il n'y a jamais qu'une poignée de convois à tester.
   */
  pickCaravan(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const camera = this.camera.position;
    const point = new THREE.Vector3();
    let bestId: string | null = null;
    let bestDistance = CARAVAN_PICK_PX;
    for (const marker of this.caravanRoot.children) {
      const id = marker.userData.caravanId;
      if (typeof id !== "string") continue;
      point.copy(marker.position);
      // Horizon d'une sphère de rayon 1 vue d'un point `c` : un point `p` de
      // la surface est visible si `p · c >= 1`. Sans ce test, les caravanes de
      // l'autre côté du globe seraient survolables à travers.
      if (point.dot(camera) < GLOBE_RADIUS * GLOBE_RADIUS) continue;
      point.project(this.camera);
      const x = rect.left + ((point.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - point.y) / 2) * rect.height;
      const distance = Math.hypot(clientX - x, clientY - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestId = id;
      }
    }
    return bestId;
  }

  /** Amène la case au centre de l'écran, en gardant la distance courante. */
  focusTile(tile: number): void {
    if (!this.hasTile(tile)) return;
    const target = this.world.tiles[tile];
    const distance = this.camera.position.length();
    this.camera.position.set(
      target.center[0] * distance,
      target.center[1] * distance,
      target.center[2] * distance,
    );
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }

  render(): void {
    if (this.disposed) return;
    this.controls.update();
    if (this.pointerDirty) {
      this.pointerDirty = false;
      const found = this.pointer === null ? null : this.pickAt(this.pointer.x, this.pointer.y);
      if (found !== this.hoverTile) {
        this.hoverTile = found;
        this.applyFan(this.hoverMesh, found);
        this.onHover?.(found);
      }
      const caravan = this.pointer === null ? null : this.pickCaravan(this.pointer.x, this.pointer.y);
      if (caravan !== this.hoverCaravan) {
        this.hoverCaravan = caravan;
        this.onHoverCaravan?.(caravan);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.markerGeometry.dispose();
    this.ownMarkerMaterial.dispose();
    this.otherMarkerMaterial.dispose();
    this.caravanGeometry.dispose();
    for (const material of this.caravanMaterials.values()) material.dispose();
    this.caravanMaterials.clear();
    this.renderer.dispose();
    // Pas de `forceContextLoss` : un contexte perdu ne se recrée pas sur le
    // même canevas, et React StrictMode monte deux fois en développement — le
    // second `GlobeRenderer` n'afficherait plus rien. C'est aussi pourquoi le
    // globe reste monté pendant la partie : un seul contexte par session.
  }

  /** Vrai si l'identifiant désigne une case de ce globe. */
  private hasTile(tile: number): boolean {
    return Number.isInteger(tile) && tile >= 0 && tile < this.world.tiles.length;
  }

  /** Matériau d'un statut, créé à la demande et réutilisé (un par statut). */
  private caravanMaterial(status: string): THREE.MeshBasicMaterial {
    const existing = this.caravanMaterials.get(status);
    if (existing !== undefined) return existing;
    const material = new THREE.MeshBasicMaterial({ color: CARAVAN_COLORS[status] ?? OTHER_COLONY });
    this.caravanMaterials.set(status, material);
    return material;
  }

  /**
   * Ajoute les segments d'un itinéraire aux tampons d'une polyligne. Les
   * points sont posés au rayon de relief de chaque case, calculé sur un globe
   * légèrement plus grand : la ligne suit le terrain sans s'y enfoncer.
   */
  private pushRoute(
    route: readonly number[],
    radius: number,
    segments: number[],
    colors: number[],
    color: THREE.Color,
  ): void {
    for (let i = 0; i + 1 < route.length; i += 1) {
      const a = route[i];
      const b = route[i + 1];
      if (!this.hasTile(a) || !this.hasTile(b)) continue;
      for (const id of [a, b]) {
        const tile = this.world.tiles[id];
        const r = tileRadius(tile, radius);
        segments.push(tile.center[0] * r, tile.center[1] * r, tile.center[2] * r);
        colors.push(color.r, color.g, color.b);
      }
    }
  }

  /** Remplace la géométrie d'un calque par le polygone d'une case. */
  private applyFan(mesh: THREE.Mesh, tile: number | null): void {
    if (tile === null || !this.hasTile(tile)) {
      mesh.visible = false;
      return;
    }
    const fan = buildTileFan(this.world.tiles[tile], GLOBE_RADIUS * OVERLAY_LIFT);
    mesh.geometry.setAttribute("position", new THREE.BufferAttribute(fan, 3));
    mesh.geometry.computeBoundingSphere();
    mesh.visible = true;
  }
}

/** Un calque translucide, posé juste au-dessus du sol. */
function overlayMesh(color: number, opacity: number, vertexColors = false): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color, vertexColors, transparent: true, opacity, depthWrite: false }),
  );
  mesh.visible = false;
  // Les calques passent après le globe : sans cela, l'égalité de profondeur
  // ferait clignoter la case survolée.
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Une polyligne d'itinéraires. `LineSegments` plutôt que `Line` : toutes les
 * routes tiennent dans une seule géométrie, alors qu'une `Line` les relierait
 * bout à bout. `vertexColors` porte la couleur du statut de chaque caravane.
 */
function routeMesh(opacity: number, vertexColors: boolean, color = 0xffffff): THREE.LineSegments {
  const mesh = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color, vertexColors, transparent: true, opacity, depthWrite: false }),
  );
  mesh.visible = false;
  mesh.renderOrder = 2;
  return mesh;
}

/** Remplace les sommets d'une polyligne, et la masque si elle est vide. */
function applySegments(mesh: THREE.LineSegments, segments: number[], colors: number[]): void {
  const geometry = mesh.geometry;
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  mesh.visible = segments.length > 0;
}

/** Fond d'étoiles : des points sur une grande sphère. Purement décoratif. */
function starfield(): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    // Distribution uniforme sur la sphère (z uniforme, angle uniforme).
    const z = Math.random() * 2 - 1;
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    positions[i * 3] = Math.cos(angle) * r * STAR_RADIUS;
    positions[i * 3 + 1] = Math.sin(angle) * r * STAR_RADIUS;
    positions[i * 3 + 2] = z * STAR_RADIUS;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xbfd4ff, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.75 }),
  );
}
