import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BUILD_KIND, FEATURE, TERRAIN } from "./terrain";

/** Dimensions en cases : le mobilier reste dans l'unique case occupée par le sim. */
export const WALL_HEIGHT = 0.56;
const C = {
  wood: 0x796044, end: 0xad9065, dark: 0x4d4031, stone: 0x88877c,
  mortar: 0x56584e, iron: 0x555954, leaf: 0x6c7942, moss: 0x505f35,
  linen: 0xd0c7ad, blanket: 0x747d52, berry: 0xa44c36, soil: 0x66503a,
};

/** Aléa purement visuel, stable après reconstruction et indépendant du RNG du sim. */
export function visualSeed(x: number, z: number): number {
  let hash = Math.imul(x + 17, 73856093) ^ Math.imul(z + 31, 19349663);
  hash = Math.imul(hash ^ hash >>> 16, 0x45d9f3b);
  return (hash ^ hash >>> 16) >>> 0;
}

/** Petites variations peintes, partagées par tous les matériaux, sans image distante. */
export function surfaceTexture(ground = false): THREE.DataTexture {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const noise = visualSeed(x, y) % 19;
    const stroke = Math.sin(x * 0.41 + Math.sin(y * 0.25) * 2) * (ground ? 7 : 3);
    const value = Math.round(233 + noise * 0.5 + stroke);
    const i = (y * size + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Grille locale des outils : les traits correspondent exactement aux limites des cases. */
export function placementTexture(): THREE.DataTexture {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const i = (z * size + x) * 4;
    pixels[i] = 192; pixels[i + 1] = 200; pixels[i + 2] = 185;
    pixels[i + 3] = x === 0 || z === 0 || x === size - 1 || z === size - 1 ? 110 : 0;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Assemble les pièces en UNE géométrie colorée : pas un draw call par brique/feuille. */
class Model {
  private parts: THREE.BufferGeometry[] = [];
  add(g: THREE.BufferGeometry, color: number, x = 0, y = 0, z = 0): void {
    g.translate(x, y, z);
    const part = g.index ? g.toNonIndexed() : g;
    if (part !== g) g.dispose();
    const tint = new THREE.Color(color);
    const colors = new Float32Array(part.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
    part.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    // Les primitives n'ont pas toutes d'UV (icosaèdres selon la version Three).
    if (!part.getAttribute("uv")) part.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(colors.length / 3 * 2), 2));
    this.parts.push(part);
  }
  box(w: number, h: number, d: number, color: number, x = 0, y = h / 2, z = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), color, x, y, z);
  }
  stone(x: number, y: number, z: number, sx: number, sy: number, sz: number, color = C.stone): void {
    this.add(new THREE.IcosahedronGeometry(1, 0).scale(sx, sy, sz).rotateY(x * 8 + z * 3), color, x, y, z);
  }
  rod(x: number, y: number, z: number, radius: number, length: number, color: number, angle = 0): void {
    this.add(new THREE.CylinderGeometry(radius * 0.86, radius, length, 7).rotateZ(angle), color, x, y, z);
  }
  log(x: number, y: number, z: number, length = 0.66, radius = 0.09): void {
    this.add(new THREE.CylinderGeometry(radius, radius * 1.06, length, 8).rotateX(Math.PI / 2), C.wood, x, y, z);
    for (const end of [-1, 1]) {
      this.add(new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, 0.008, 8).rotateX(Math.PI / 2), C.end, x, y, z + end * length / 2);
    }
  }
  finish(): THREE.BufferGeometry {
    const geometry = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    if (!geometry) throw new Error("Géométrie de prop incompatible");
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function wall(m: Model, stone: boolean): void {
  // Un module occupe toute la case : aucune fausse allée entre deux murs.
  m.box(1, WALL_HEIGHT - 0.035, 1, stone ? C.mortar : C.dark);
  if (stone) {
    for (let row = 0; row < 3; row++) {
      const cuts = row % 2 ? [-0.5, -0.25, 0.25, 0.5] : [-0.5, 0, 0.5];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1];
        m.box(b - a - 0.018, 0.158, 0.988, [0x858579, 0x929084, 0x7c8076][(row + i) % 3], (a + b) / 2, 0.087 + row * 0.169);
      }
    }
  } else {
    for (let row = 0; row < 3; row++) m.box(0.995, 0.153, 0.98, row % 2 ? 0x806849 : C.wood, 0, 0.085 + row * 0.162);
  }
  if (stone) {
    for (let i = 0; i < 4; i++) m.box(0.481, 0.035, 0.481, [0x9b998b, 0x8c8e82, 0xa19d90, 0x929487][i], (i % 2 - 0.5) * 0.499, WALL_HEIGHT - 0.0175, (Math.floor(i / 2) - 0.5) * 0.499);
  } else {
    for (let i = 0; i < 4; i++) m.box(0.23, 0.035, 0.985, i % 2 ? C.end : 0x9c8056, -0.36 + i * 0.24, WALL_HEIGHT - 0.0175);
  }
}

function door(m: Model, stone: boolean): void {
  m.box(0.98, 0.035, 0.48, stone ? C.stone : C.dark);
  for (const x of [-0.425, 0.425]) m.box(0.13, WALL_HEIGHT, 0.4, stone ? C.stone : C.wood, x);
  for (let i = 0; i < 5; i++) m.box(0.136, 0.35, 0.085, i % 2 ? C.wood : 0x8d7350, -0.282 + i * 0.141, 0.2);
  for (const y of [0.11, 0.32]) m.box(0.69, 0.033, 0.105, C.iron, 0, y);
  m.box(0.055, 0.07, 0.045, C.end, 0.23, 0.21, 0.068);
}

function bed(m: Model): void {
  for (const x of [-0.29, 0.29]) for (const z of [-0.39, 0.39]) m.box(0.07, 0.2, 0.07, C.dark, x, 0.1, z);
  m.box(0.68, 0.1, 0.92, C.wood, 0, 0.18);
  m.box(0.61, 0.09, 0.8, C.linen, 0, 0.272);
  m.box(0.625, 0.07, 0.55, C.blanket, 0, 0.34, 0.115);
  m.box(0.63, 0.03, 0.055, 0x979a73, 0, 0.389, -0.11);
  m.box(0.43, 0.075, 0.17, 0xe0d8c4, 0, 0.351, -0.29);
  m.box(0.7, 0.43, 0.065, C.wood, 0, 0.215, -0.44);
  m.box(0.7, 0.28, 0.065, C.wood, 0, 0.14, 0.44);
}

function bench(m: Model): void {
  for (const x of [-0.36, 0.36]) for (const z of [-0.24, 0.24]) m.box(0.09, 0.47, 0.09, C.dark, x, 0.235, z);
  m.box(0.8, 0.055, 0.49, C.wood, 0, 0.16);
  for (let i = 0; i < 4; i++) m.box(0.91, 0.085, 0.158, i % 2 ? 0x9b7e55 : 0x8d724d, 0, 0.51, -0.25 + i * 0.167);
  m.box(0.74, 0.13, 0.045, C.wood, 0, 0.59, -0.34);
  m.box(0.18, 0.04, 0.19, C.end, -0.19, 0.57, 0.03);
  m.box(0.045, 0.035, 0.23, C.dark, 0.16, 0.57, 0.03);
  m.box(0.16, 0.075, 0.07, C.iron, 0.16, 0.61, -0.065);
  m.log(-0.08, 0.26, 0.015, 0.35, 0.065);
}

function plant(m: Model, ripe: boolean): void {
  for (const x of [-0.23, 0.23]) for (const z of [-0.23, 0.23]) {
    m.rod(x, 0.13, z, 0.018, 0.24, C.moss);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      m.stone(x + Math.cos(a) * 0.075, 0.13 + i % 2 * 0.055, z + Math.sin(a) * 0.075, 0.11, 0.04, 0.07, ripe ? 0x8b934c : C.leaf);
    }
    if (ripe) m.stone(x, 0.085, z, 0.07, 0.06, 0.07, 0xb69552);
  }
}

function fire(m: Model): void {
  for (let i = 0; i < 9; i++) {
    const a = i * Math.PI * 2 / 9;
    m.stone(Math.cos(a) * 0.32, 0.085, Math.sin(a) * 0.32, 0.1, 0.08, 0.095);
  }
  for (const x of [-0.09, 0.09]) m.log(x, 0.1, 0, 0.46, 0.055);
  m.add(new THREE.ConeGeometry(0.12, 0.32, 5).rotateZ(-0.15), 0xdb8139, 0, 0.23);
  m.add(new THREE.ConeGeometry(0.065, 0.24, 5), 0xffc668, 0.03, 0.22, 0.025);
}

function tree(m: Model): void {
  m.rod(0, 0.53, 0, 0.09, 1.06, C.wood);
  m.rod(-0.13, 0.76, 0, 0.045, 0.53, C.wood, 0.48);
  m.rod(0.15, 0.93, 0.05, 0.04, 0.52, C.wood, -0.52);
  for (let i = 0; i < 11; i++) {
    const a = i * 2.399;
    const r = i > 7 ? 0.14 : 0.28;
    m.stone(Math.cos(a) * r, 1.05 + i * 0.052, Math.sin(a) * r, 0.27, 0.33, 0.25, [C.leaf, C.moss, 0x7c8549, 0x65723b][i % 4]);
  }
  for (let i = 0; i < 3; i++) m.stone((i - 1) * 0.09, 0.035, 0.06, 0.08, 0.04, 0.13, C.dark);
}

function bush(m: Model, ripe: boolean): void {
  for (let i = 0; i < 5; i++) {
    const a = i * 2.399;
    const x = Math.cos(a) * 0.18, z = Math.sin(a) * 0.18;
    m.stone(x, 0.23, z, 0.21, 0.24, 0.2, i % 2 ? C.moss : C.leaf);
    if (ripe) m.stone(x + 0.055, 0.39, z + 0.065, 0.043, 0.04, 0.04, C.berry);
  }
}

function rocks(m: Model): void {
  m.stone(-0.07, 0.32, -0.03, 0.34, 0.39, 0.3);
  m.stone(0.26, 0.18, 0.1, 0.21, 0.22, 0.24, 0x99998c);
  m.stone(-0.26, 0.115, 0.26, 0.16, 0.14, 0.19, 0x72786f);
  m.stone(0.03, 0.1, 0.3, 0.12, 0.12, 0.13, 0xa4a294);
}

function basket(m: Model, kind: number): void {
  m.add(new THREE.CylinderGeometry(0.3, 0.23, 0.22, 10), C.wood, 0, 0.11);
  m.add(new THREE.TorusGeometry(0.287, 0.027, 4, 12).rotateX(Math.PI / 2), C.end, 0, 0.23);
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4;
    m.stone(Math.cos(a) * 0.16, 0.235 + i % 2 * 0.025, Math.sin(a) * 0.16, 0.071, 0.062, 0.067, kind === 2 ? C.berry : 0x899650);
  }
}

function item(m: Model, kind: number): void {
  if (kind === 0) {
    for (const [x, y] of [[-0.2, 0.1], [0, 0.1], [0.2, 0.1], [-0.1, 0.265], [0.1, 0.265]]) m.log(x, y, 0);
  } else if (kind === 1) {
    for (let i = 0; i < 6; i++) m.stone((i % 3 - 1) * 0.2, 0.095 + Math.floor(i / 3) * 0.12, (i % 2 - 0.5) * 0.24, 0.15, 0.11, 0.15, i % 2 ? 0x97978b : C.stone);
  } else if (kind === 2 || kind === 3) basket(m, kind);
  else if (kind === 4) {
    m.add(new THREE.CylinderGeometry(0.26, 0.21, 0.065, 12), C.linen, 0, 0.045);
    m.stone(-0.065, 0.11, 0, 0.13, 0.065, 0.14, 0xb99a61);
    m.stone(0.1, 0.1, 0.045, 0.09, 0.05, 0.12, C.leaf);
  } else if (kind === 5 || kind >= 9 && kind <= 11) {
    const hide = kind === 10 ? 0xa4a095 : kind === 11 ? C.dark : 0x8c7050;
    m.stone(0, 0.14, 0, 0.19, 0.14, kind === 10 ? 0.24 : 0.34, hide);
    m.stone(0.01, 0.15, 0.33, 0.12, 0.11, 0.13, kind === 5 ? 0xbe9974 : hide);
    for (const x of [-0.16, 0.16]) m.box(0.07, 0.07, 0.23, hide, x, 0.055, -0.22);
  } else if (kind === 6 || kind === 7) {
    m.log(0, 0.065, 0, 0.72, kind === 6 ? 0.055 : 0.024);
    if (kind === 7) m.add(new THREE.ConeGeometry(0.068, 0.17, 5).rotateX(Math.PI / 2), C.iron, 0, 0.073, 0.36);
  } else if (kind === 8) {
    m.add(new THREE.TorusGeometry(0.28, 0.025, 5, 14, Math.PI).rotateX(-Math.PI / 2), C.end, 0, 0.05);
    m.box(0.56, 0.01, 0.012, C.linen, 0, 0.05);
  } else if (kind === 12) {
    for (const z of [-0.1, 0.1]) m.stone(0, 0.09, z, 0.23, 0.085, 0.12, 0x9f5147);
  } else if (kind === 13) {
    for (let i = 0; i < 3; i++) m.box(0.48 - i * 0.035, 0.035, 0.4, i % 2 ? 0xa58960 : C.end, i * 0.02, 0.03 + i * 0.037);
  } else if (kind === 14 || kind === 15) {
    const cloth = kind === 14 ? 0x99917a : 0x6c7461;
    m.box(0.33, 0.08, 0.4, cloth, 0, 0.065);
    for (const x of [-0.19, 0.19]) m.box(0.12, 0.08, 0.23, cloth, x, 0.065, -0.065);
    m.box(0.13, 0.025, 0.08, C.linen, 0, 0.117, -0.155);
  } else m.box(0.32, 0.22, 0.32, C.wood);
}

/**
 * Tombe (`Feature::Grave` = 14 vide, `GraveFilled` = 15 occupée) : un tertre
 * de terre remuée bordé de pierres plates, une case entière comme le sim
 * l'impose (matériau pierre forcé, jamais de variante bois). Occupée, le
 * tertre est bombé et porte une petite stèle ; vide, la terre reste à plat.
 */
function grave(m: Model, filled: boolean): void {
  // Bordure de pierres plates creusée dans le sol, commune aux deux états.
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    m.stone(Math.cos(a) * 0.37, 0.035, Math.sin(a) * 0.37, 0.09, 0.032, 0.09, i % 2 ? 0x8c8e82 : C.stone);
  }
  if (filled) {
    // Tertre bombé : terre remuée en dôme.
    m.stone(0, 0.11, 0, 0.3, 0.09, 0.3, C.soil);
    // Stèle de pierre plantée en tête de tombe, avec son chapeau.
    m.box(0.16, 0.26, 0.05, 0x8c8e82, 0, 0.13, -0.2);
    m.box(0.19, 0.04, 0.07, 0x76766b, 0, 0.24, -0.2);
  } else {
    // Tombe vide : terre remuée à plat, plus sombre que le sol autour.
    m.add(new THREE.CylinderGeometry(0.3, 0.28, 0.04, 10), C.soil, 0, 0.02);
  }
}

/**
 * Établi de recherche (`Feature::ResearchBench` = 16) : une table de travail,
 * un tabouret et un livre ouvert (encrier et plume à côté), une case entière
 * comme le sim l'impose (matériau bois forcé, comme la tombe force la pierre).
 */
function researchBench(m: Model): void {
  // Table : quatre pieds, un plateau.
  for (const x of [-0.32, 0.32]) for (const z of [-0.19, 0.19]) m.box(0.06, 0.4, 0.06, C.dark, x, 0.2, z);
  m.box(0.72, 0.045, 0.44, C.wood, 0, 0.4225);
  // Un tabouret, dans un coin de la case.
  for (const x of [-0.06, 0.06]) for (const z of [-0.06, 0.06]) m.box(0.04, 0.24, 0.04, C.dark, x - 0.3, 0.12, z + 0.32);
  m.box(0.22, 0.035, 0.22, C.wood, -0.3, 0.2575, 0.32);
  // Un livre ouvert sur la table, reliure au milieu.
  m.box(0.2, 0.02, 0.16, C.linen, -0.09, 0.4555, 0);
  m.box(0.2, 0.02, 0.16, C.linen, 0.09, 0.4555, 0);
  m.box(0.015, 0.028, 0.17, C.iron, 0, 0.459, 0);
  // Un encrier et sa plume, à l'autre bout du plateau.
  m.add(new THREE.CylinderGeometry(0.05, 0.06, 0.05, 8), C.dark, 0.24, 0.47, -0.12);
  m.rod(0.22, 0.53, -0.1, 0.012, 0.16, 0x8a6a4a, 0.6);
}

/**
 * Piège à pointes (`Feature::SpikeTrap` = 17 armé, `SpikeTrapSprung` = 18
 * déclenché) : une case entière, matériau bois imposé comme pour l'établi de
 * recherche. Armé, la plaque de planches reste presque affleurante et les
 * pointes à peine sorties — discret pour un pillard, qui ne le voit jamais
 * venir, mais reconnaissable de près pour le joueur. Déclenché, une planche
 * sur deux a sauté et les pointes se dressent, sans ambiguïté possible.
 */
function spikeTrap(m: Model, sprung: boolean): void {
  for (let i = 0; i < 4; i++) {
    // Déclenché, une rangée sur deux a été arrachée par la détente : ce qui
    // reste est plus étroit, pas juste plus haut.
    if (sprung && i % 2 === 0) continue;
    const z = -0.33 + i * 0.22;
    m.box(sprung ? 0.5 : 0.86, 0.026, 0.2, i % 2 ? 0x7a6142 : C.wood, 0, 0.013, z);
  }
  // Pointes de fer : à peine sorties tant que le piège est armé, dressées
  // pleinement une fois déclenché.
  for (let i = 0; i < 5; i++) {
    const a = i * 2.51;
    const x = Math.cos(a) * 0.22, z = Math.sin(a) * 0.22;
    const h = sprung ? 0.3 : 0.05;
    m.add(new THREE.ConeGeometry(0.034, h, 5), 0x6d6f68, x, 0.026 + h / 2, z);
  }
}

function floorDetail(m: Model, wood: boolean): void {
  // Dessins à plat : overlays de zone/intérieur restent au-dessus du sol.
  for (let i = 0; i < (wood ? 5 : 4); i++) {
    const w = wood ? 0.185 : 0.479;
    const d = wood ? 0.975 : 0.479;
    const x = wood ? -0.388 + i * 0.194 : (i % 2 - 0.5) * 0.49;
    const z = wood ? 0 : (Math.floor(i / 2) - 0.5) * 0.49;
    m.add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), wood ? [0x967c57, 0x88724f, 0x9c835e][i % 3] : [0x919084, 0x888a80, 0x98968a][i % 3], x, 0.004, z);
  }
}

/** Densité des props (menu Options → Graphismes) : mêmes valeurs que `GraphicsSettings.propDensity`. */
export type PropDensity = "haute" | "moyenne" | "basse";

/**
 * Vrai si la feature `f` (`FEATURE`, voir `terrain.ts`) s'instancie à la
 * densité `density` — utilisé par `Renderer.setPropDensity` pour alléger le
 * rendu sur une machine modeste. `haute` garde tout ce que le sim envoie.
 * `moyenne` retire les rochers et les buissons (mûrs ou non) : un détail
 * décoratif pur, sans information de jeu — la désignation de coupe se lit
 * sur l'overlay orange, pas sur la silhouette du buisson. `basse` retire en
 * plus les cultures : la zone de culture (overlay brun) suffit à savoir où
 * elles poussent. Arbres, murs, portes, lits, feux de camp, établis, tombes
 * et pièges — les constructions au sens de `BUILD_KIND`, plus l'arbre —
 * restent dessinés à toute densité, comme les objets (`itemProps`) et les
 * chantiers (`blueprintProps`), jamais filtrés ici.
 */
export function featureVisibleAtDensity(f: number, density: PropDensity): boolean {
  if (density === "haute") return true;
  if (f === FEATURE.Rock || f === FEATURE.Bush || f === FEATURE.BushUnripe) return false;
  if (density === "basse" && (f === FEATURE.Crop || f === FEATURE.CropRipe)) return false;
  return true;
}

export function blueprintKey(kind: number, material: number): string {
  switch (kind) {
    case BUILD_KIND.Wall: return `feature:${material === 1 ? FEATURE.WallStone : FEATURE.WallWood}`;
    case BUILD_KIND.Door: return `feature:${material === 1 ? FEATURE.DoorStone : FEATURE.DoorWood}`;
    case BUILD_KIND.Floor: return `floor:${material === 1 ? TERRAIN.StoneFloor : TERRAIN.WoodFloor}`;
    case BUILD_KIND.Bed: return `feature:${FEATURE.Bed}`;
    case BUILD_KIND.Campfire: return `feature:${FEATURE.Campfire}`;
    case BUILD_KIND.CraftingSpot: return `feature:${FEATURE.CraftingSpot}`;
    // Matériau pierre imposé (le sim ignore le matériau demandé) : une seule
    // géométrie, quel que soit `material` reçu.
    case BUILD_KIND.Grave: return `feature:${FEATURE.Grave}`;
    // Matériau bois imposé, même contrat que la tombe : une seule géométrie.
    case BUILD_KIND.ResearchBench: return `feature:${FEATURE.ResearchBench}`;
    // Matériau bois imposé, même contrat ; posé, le piège est armé d'emblée.
    case BUILD_KIND.SpikeTrap: return `feature:${FEATURE.SpikeTrap}`;
    default: return "item:unknown";
  }
}

/** Orientation commune aux portes construites et planifiées, bords de carte compris. */
export function doorRotation(x: number, z: number, width: number, height: number, wallAt: (index: number) => boolean): number {
  const alongX = x > 0 && wallAt(z * width + x - 1) || x + 1 < width && wallAt(z * width + x + 1);
  const alongZ = z > 0 && wallAt((z - 1) * width + x) || z + 1 < height && wallAt((z + 1) * width + x);
  return !alongX && alongZ ? Math.PI / 2 : 0;
}

export class PropLibrary {
  private geometries = new Map<string, THREE.BufferGeometry>();
  readonly texture = surfaceTexture();
  readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.texture });
  readonly ghostMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.36, depthWrite: false });

  geometry(key: string, ghost = false): THREE.BufferGeometry {
    const cacheKey = ghost ? `ghost:${key}` : key;
    const cached = this.geometries.get(cacheKey);
    if (cached) return cached;
    if (ghost) {
      const g = this.geometry(key).clone();
      g.deleteAttribute("color");
      this.geometries.set(cacheKey, g);
      return g;
    }
    const m = new Model();
    const [type, value] = key.split(":"), n = Number(value);
    if (type === "item") item(m, n);
    else if (type === "floor") floorDetail(m, n === TERRAIN.WoodFloor);
    else switch (n) {
      case FEATURE.Tree: tree(m); break;
      case FEATURE.Rock: rocks(m); break;
      case FEATURE.Bush: bush(m, true); break;
      case FEATURE.BushUnripe: bush(m, false); break;
      case FEATURE.WallWood: wall(m, false); break;
      case FEATURE.WallStone: wall(m, true); break;
      case FEATURE.DoorWood: door(m, false); break;
      case FEATURE.DoorStone: door(m, true); break;
      case FEATURE.Bed: bed(m); break;
      case FEATURE.Crop: plant(m, false); break;
      case FEATURE.CropRipe: plant(m, true); break;
      case FEATURE.Campfire: fire(m); break;
      case FEATURE.CraftingSpot: bench(m); break;
      case FEATURE.Grave: grave(m, false); break;
      case FEATURE.GraveFilled: grave(m, true); break;
      case FEATURE.ResearchBench: researchBench(m); break;
      case FEATURE.SpikeTrap: spikeTrap(m, false); break;
      case FEATURE.SpikeTrapSprung: spikeTrap(m, true); break;
      default: m.box(0.3, 0.3, 0.3, C.wood);
    }
    const g = m.finish();
    this.geometries.set(cacheKey, g);
    return g;
  }
  dispose(): void {
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.material.dispose();
    this.ghostMaterial.dispose();
    this.texture.dispose();
  }
}

export interface PropInstance {
  key: string;
  x: number;
  z: number;
  y?: number;
  rotation?: number;
  scale?: number;
  tint?: number;
}

/** Tampons réutilisés : croissent au besoin, aucune géométrie reconstruite par frame. */
export class PropBatch {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.InstancedMesh>();
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private quaternion = new THREE.Quaternion();
  private scale = new THREE.Vector3();
  private color = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  constructor(private library: PropLibrary, private ghost = false) {}

  sync(entries: readonly PropInstance[]): void {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    for (const [key, count] of counts) {
      const old = this.meshes.get(key);
      if (old && old.instanceMatrix.count >= count) continue;
      if (old) { this.group.remove(old); old.dispose(); }
      const mesh = new THREE.InstancedMesh(this.library.geometry(key, this.ghost), this.ghost ? this.library.ghostMaterial : this.library.material, Math.max(4, 2 ** Math.ceil(Math.log2(count))));
      mesh.name = key;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = !this.ghost && !key.startsWith("floor:");
      mesh.receiveShadow = !this.ghost;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
    for (const mesh of this.meshes.values()) { mesh.count = 0; mesh.visible = false; }
    for (const e of entries) {
      const mesh = this.meshes.get(e.key)!;
      const s = e.scale ?? 1;
      this.matrix.compose(this.position.set(e.x, e.y ?? 0, e.z), this.quaternion.setFromAxisAngle(this.up, e.rotation ?? 0), this.scale.setScalar(s));
      mesh.setMatrixAt(mesh.count, this.matrix);
      mesh.setColorAt(mesh.count++, this.color.setHex(e.tint ?? 0xffffff));
      mesh.visible = true;
    }
    for (const mesh of this.meshes.values()) {
      if (!mesh.visible) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Les objets mobiles peuvent sortir de la sphère de la frame précédente.
      mesh.computeBoundingSphere();
    }
  }
  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.group.clear();
  }
}
