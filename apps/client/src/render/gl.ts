/**
 * Le **seul** contexte WebGL de l'onglet.
 *
 * Trois écrans dessinent dans ce dépôt — le globe (`GlobeRenderer`), la
 * colonie (`Renderer`) et la revue de props (`dev/propsPreview.ts`) — et un
 * joueur passe de l'un à l'autre sans arrêt. Un `WebGLRenderer` par écran, ce
 * sont autant de contextes : les navigateurs en plafonnent le nombre (souvent
 * seize) et **perdent le plus ancien** quand on dépasse, ce qui finit en écran
 * noir au bout de quelques allers-retours. Un contexte ne se libère pas non
 * plus à la demande : `renderer.dispose()` rend les ressources GPU, pas le
 * contexte lui-même, qui n'est réellement rendu qu'à la collecte du canevas.
 *
 * D'où ce module : **un** canevas, **un** `WebGLRenderer`, mémoïsés comme
 * l'init wasm-bindgen de `SimHandle.ts` (React StrictMode monte deux fois).
 * Les écrans les empruntent :
 *
 * ```ts
 * const gl = acquireGl();          // crée à la première demande, mémoïse ensuite
 * gl.attach(host);                 // le canevas passe dans le conteneur de l'écran
 * const renderer = new Renderer(gl, host);
 * // …
 * renderer.dispose();              // géométries, matériaux, textures de l'écran
 * gl.detach(host);                 // rend le canevas
 * gl.release();                    // un utilisateur de moins
 * ```
 *
 * Le canevas **se déplace** d'un conteneur à l'autre plutôt que d'être
 * dupliqué : c'est ce qui route aussi les entrées, puisque chaque écran écoute
 * la souris sur *son* conteneur et ne voit donc rien tant que le canevas est
 * chez le voisin. Les contrôles de caméra (`MapControls`, `OrbitControls`) se
 * branchent pour la même raison sur le conteneur, jamais sur le canevas
 * partagé.
 *
 * Réglages globaux : ils sont posés **une fois** ici (rapport de pixels,
 * espace colorimétrique, mapping de tons, ombres, couleur d'effacement). Le
 * fond, lui, est porté par `Scene.background`, donc propre à chaque écran sans
 * rien à réappliquer. Les ombres restent allumées en permanence même si seule
 * la colonie s'en sert : basculer `shadowMap.enabled` en cours de route oblige
 * Three.js à recompiler tous les matériaux, et le globe n'a aucun objet
 * `castShadow` — la passe d'ombre n'y coûte rien.
 *
 * Perte de contexte : le navigateur peut reprendre le contexte à tout moment
 * (veille, changement de GPU, onglet en arrière-plan). On l'annonce en
 * console, on marque `contextLost` (les écrans cessent de dessiner) et on
 * préviens les abonnés de `onRestored` à la restauration. Three.js reconstruit
 * lui-même son état GPU ; les rappels servent aux ressources que les écrans
 * fabriquent de leur côté.
 */

import * as THREE from "three";
import { loadGraphics } from "../settings";

/** Rapport de pixels maximal : au-delà, on paie du remplissage pour rien. */
const MAX_PIXEL_RATIO = 2;

/**
 * Couleur d'effacement par défaut, celle du fond de page (`styles.css`).
 * Chaque écran pose sa propre `Scene.background`, qui la recouvre ; elle ne se
 * voit que le temps d'une frame sans scène.
 */
const CLEAR_COLOR = 0x0b0f14;

/** Le couple indissociable fabriqué au premier `acquireGl`. */
export interface GlBackend {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
}

/** Fabrique du couple ci-dessus. Remplaçable en test (voir `setGlBackendForTests`). */
export type GlBackendFactory = () => GlBackend;

/** Ce qu'un écran emprunte. Voir l'en-tête du module pour le cycle de vie. */
export interface SharedGl {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** Conteneur qui porte le canevas, `null` s'il est détaché. */
  readonly container: HTMLElement | null;
  /** Vrai entre `webglcontextlost` et `webglcontextrestored` : ne pas dessiner. */
  readonly contextLost: boolean;
  /** Nombre d'écrans qui tiennent le contexte (voir `acquireGl` / `release`). */
  readonly users: number;
  /**
   * Déplace le canevas dans ce conteneur et le remesure. Appelé deux fois de
   * suite avec le même conteneur, ne fait que remesurer : StrictMode monte
   * deux fois, et un canevas qui saute hors du DOM entre deux montages perdrait
   * sa taille.
   */
  attach(container: HTMLElement): void;
  /**
   * Sort le canevas du DOM. Avec un conteneur en argument, ne fait rien s'il
   * n'est plus celui qui porte le canevas : deux écrans qui se le passent
   * peuvent ainsi appeler `detach` dans n'importe quel ordre sans se voler le
   * canevas l'un l'autre.
   */
  detach(container?: HTMLElement): void;
  /** Retaille le tampon de rendu. Sans argument, reprend la taille du conteneur. */
  resize(width?: number, height?: number): void;
  /**
   * Change le rapport de pixels à la volée (menu Options → Graphismes), et
   * redimensionne aussitôt : `WebGLRenderer.setPixelRatio` retaille déjà son
   * tampon interne, mais seul `resize()` prévient les abonnés de `onResize`
   * (la caméra de chaque écran).
   */
  setPixelRatio(value: number): void;
  /** S'abonne aux changements de taille. Renvoie de quoi se désabonner. */
  onResize(callback: (width: number, height: number) => void): () => void;
  /** S'abonne à la restauration du contexte. Renvoie de quoi se désabonner. */
  onRestored(callback: () => void): () => void;
  /** Un utilisateur de moins. Le contexte n'est jamais détruit : il est réutilisé. */
  release(): void;
}

class Gl implements SharedGl {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;

  private host: HTMLElement | null = null;
  private lost = false;
  private count = 0;
  private readonly resizeListeners = new Set<(width: number, height: number) => void>();
  private readonly restoredListeners = new Set<() => void>();
  private readonly observer: ResizeObserver | null;

  private readonly onWindowResize = () => this.resize();

  private readonly onContextLost = (event: Event) => {
    // Sans `preventDefault`, le navigateur ne tentera aucune restauration : le
    // contexte serait perdu pour de bon.
    event.preventDefault();
    this.lost = true;
    console.warn("[gl] contexte WebGL perdu — le rendu s'arrête jusqu'à sa restauration");
  };

  private readonly onContextRestored = () => {
    this.lost = false;
    console.warn("[gl] contexte WebGL restauré — les écrans rebâtissent leurs ressources");
    // Copie : un rappel peut se désabonner en s'exécutant.
    for (const callback of [...this.restoredListeners]) callback();
  };

  constructor(backend: GlBackend) {
    this.canvas = backend.canvas;
    this.renderer = backend.renderer;

    // --- Réglages globaux, posés une fois pour les deux écrans ---
    this.renderer.setPixelRatio(Math.min(devicePixelRatio(), MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    // Réglage « ombres » du menu Options : lu ici, une bonne fois pour toutes.
    // Le rebasculer en cours de route obligerait Three.js à recompiler tous
    // les matériaux (voir l'en-tête du module) : le menu prévient qu'il ne
    // s'applique qu'au prochain chargement.
    this.renderer.shadowMap.enabled = loadGraphics().shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(CLEAR_COLOR, 1);

    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    // Un seul observateur pour tout l'onglet, sur le conteneur du moment. Le
    // repli sur l'événement `resize` de la fenêtre sert aux environnements sans
    // `ResizeObserver` (tests sous Node).
    this.observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    if (this.observer === null && typeof window !== "undefined") {
      window.addEventListener("resize", this.onWindowResize);
    }
  }

  get container(): HTMLElement | null {
    return this.host;
  }

  get contextLost(): boolean {
    return this.lost;
  }

  get users(): number {
    return this.count;
  }

  /** Réservé à `acquireGl`. */
  retain(): void {
    this.count += 1;
  }

  release(): void {
    this.count = Math.max(0, this.count - 1);
    // Plus personne à l'écran : on sort le canevas du DOM, mais on **garde** le
    // renderer. Le recréer, c'est exactement le contexte de plus qu'on évite.
    if (this.count === 0) this.detach();
  }

  attach(container: HTMLElement): void {
    if (this.host === container) {
      // Deuxième montage StrictMode, ou simple remesure : rien à déplacer.
      this.resize();
      return;
    }
    if (this.host !== null) this.observer?.unobserve(this.host);
    this.host = container;
    // `appendChild` déplace le nœud s'il était ailleurs : pas de doublon.
    container.appendChild(this.canvas);
    this.observer?.observe(container);
    this.resize();
  }

  detach(container?: HTMLElement): void {
    if (this.host === null) return;
    if (container !== undefined && container !== this.host) return;
    this.observer?.unobserve(this.host);
    this.host = null;
    this.canvas.remove();
  }

  resize(width?: number, height?: number): void {
    const host = this.host;
    if (width === undefined && height === undefined && host === null) return;
    const w = Math.max(1, Math.round(width ?? measure(host, "clientWidth", 1)));
    const h = Math.max(1, Math.round(height ?? measure(host, "clientHeight", 1)));
    // `false` : la taille CSS du canevas vient de la feuille de style (100 % du
    // conteneur), seul le tampon de rendu est piloté ici.
    this.renderer.setSize(w, h, false);
    for (const callback of [...this.resizeListeners]) callback(w, h);
  }

  onResize(callback: (width: number, height: number) => void): () => void {
    this.resizeListeners.add(callback);
    return () => this.resizeListeners.delete(callback);
  }

  setPixelRatio(value: number): void {
    this.renderer.setPixelRatio(value);
    // Reprend le chemin de `resize()` : mêmes abonnés prévenus qu'un
    // redimensionnement de fenêtre, aucun besoin de dupliquer la logique.
    this.resize();
  }

  onRestored(callback: () => void): () => void {
    this.restoredListeners.add(callback);
    return () => this.restoredListeners.delete(callback);
  }
}

/** Taille d'un conteneur, avec repli sur la fenêtre puis sur `fallback`. */
function measure(host: HTMLElement | null, key: "clientWidth" | "clientHeight", fallback: number): number {
  const own = host?.[key] ?? 0;
  if (own > 0) return own;
  if (typeof window === "undefined") return fallback;
  const viewport = key === "clientWidth" ? window.innerWidth : window.innerHeight;
  return viewport > 0 ? viewport : fallback;
}

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

function defaultBackend(): GlBackend {
  const canvas = document.createElement("canvas");
  // La feuille de style l'étire à 100 % de son conteneur (`styles.css`).
  canvas.className = "scene-gl";
  return { canvas, renderer: new THREE.WebGLRenderer({ canvas, antialias: true }) };
}

let backendFactory: GlBackendFactory = defaultBackend;
let shared: Gl | null = null;

/**
 * Le contexte partagé, créé à la première demande puis mémoïsé. Chaque appel
 * compte un utilisateur de plus : appeler `release()` quand l'écran se ferme.
 */
export function acquireGl(): SharedGl {
  shared ??= new Gl(backendFactory());
  shared.retain();
  return shared;
}

/**
 * **Tests seulement** : remplace la fabrique et oublie le contexte mémoïsé, de
 * sorte que le prochain `acquireGl` reparte de zéro. `null` remet la fabrique
 * réelle. Jamais appelé par le jeu.
 */
export function setGlBackendForTests(factory: GlBackendFactory | null): void {
  backendFactory = factory ?? defaultBackend;
  shared = null;
}

/**
 * Rend les géométries et matériaux d'un sous-arbre de scène. **Ne touche pas
 * aux textures** : elles sont partagées (le catalogue de props, les étiquettes
 * de nom mises en cache par `Renderer`) et appartiennent à qui les a créées,
 * qui les rend explicitement. Un même matériau ou une même géométrie rendus
 * deux fois ne posent pas de problème à Three.js.
 */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const holder = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
      dispose?: () => void;
    };
    // Piège Three.js : tous les `Sprite` d'une page partagent **une seule**
    // géométrie interne au moteur. La rendre ici la retirerait du GPU pour les
    // étiquettes de tout le monde, y compris celles d'un écran encore ouvert.
    if (!(object instanceof THREE.Sprite)) holder.geometry?.dispose();
    const material = holder.material;
    if (Array.isArray(material)) {
      for (const one of material) one.dispose();
    } else {
      material?.dispose();
    }
    // `InstancedMesh` (tampons d'instances) et `DirectionalLight` (sa carte
    // d'ombre) ont leur propre `dispose` ; `Group`, `Mesh` et `Sprite` non.
    holder.dispose?.();
  });
}
