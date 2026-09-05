/**
 * Le contexte WebGL unique de l'onglet (`src/render/gl.ts`), éprouvé sans GPU
 * ni DOM.
 *
 * Ce qui se teste à froid, c'est la comptabilité : la mémoïsation (un seul
 * contexte, quel que soit le nombre d'écrans), le compteur d'utilisateurs,
 * l'idempotence de `attach` (React StrictMode monte deux fois), le passage du
 * canevas d'un conteneur à l'autre, et les rappels de perte/restauration de
 * contexte. Le rendu lui-même se regarde à l'écran.
 *
 * Le vrai `WebGLRenderer` est remplacé par un faux via `setGlBackendForTests`,
 * qui oublie aussi le contexte mémoïsé : chaque test repart d'un onglet neuf.
 *
 * Ce que ce test **ne peut pas** vérifier : que `renderer.info.memory` ne monte
 * pas d'un aller-retour globe → colonie → globe, faute de vrai contexte. Le
 * contrôle se fait au navigateur, voir `AGENTS.md` § « Vérifier dans le
 * navigateur » :
 *
 * ```js
 * const m = () => ({ ...window.__rimlike.gl.renderer.info.memory });
 * m();                                    // globe seul
 * window.__rimlike.world.settle();        // → colonie
 * window.__rimlike.world.back();          // → globe : mêmes compteurs
 * ```
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { acquireGl, disposeTree, setGlBackendForTests, type GlBackend } from "../src/render/gl";

/** Un nœud DOM minimal : parenté, taille, écouteurs. Le strict nécessaire de `gl.ts`. */
class FakeNode {
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;
  clientWidth = 800;
  clientHeight = 600;
  className = "";
  appendCalls = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  appendChild(child: FakeNode): FakeNode {
    this.appendCalls += 1;
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeNode): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parent = null;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((f) => f !== fn);
    this.listeners.set(type, list);
  }

  /** Déclenche un événement, avec le `preventDefault` qu'attend `gl.ts`. */
  fire(type: string): void {
    const event = { preventDefault: () => {} };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

/** Un `WebGLRenderer` de façade : il note ce qu'on lui demande, il ne dessine rien. */
class FakeRenderer {
  pixelRatio = 0;
  outputColorSpace = "";
  toneMapping = -1;
  readonly shadowMap = { enabled: false, type: -1 };
  readonly sizes: Array<[number, number]> = [];
  clearColor: number | null = null;

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }

  setSize(width: number, height: number): void {
    this.sizes.push([width, height]);
  }

  setClearColor(color: number): void {
    this.clearColor = color;
  }
}

interface Fakes {
  readonly canvas: FakeNode;
  readonly renderer: FakeRenderer;
  /** Nombre de fabrications : c'est lui qui prouve la mémoïsation. */
  built: () => number;
}

/** Installe une fabrique de façade et rend de quoi l'inspecter. */
function useFakeGl(): Fakes {
  const canvas = new FakeNode();
  const renderer = new FakeRenderer();
  let built = 0;
  setGlBackendForTests(() => {
    built += 1;
    return { canvas, renderer } as unknown as GlBackend;
  });
  return { canvas, renderer, built: () => built };
}

function host(): FakeNode {
  return new FakeNode();
}

/** Le conteneur vu par `gl.ts`, qui n'en attend qu'un sous-ensemble DOM. */
function asElement(node: FakeNode): HTMLElement {
  return node as unknown as HTMLElement;
}

afterEach(() => {
  setGlBackendForTests(null);
  vi.restoreAllMocks();
});

describe("contexte WebGL partagé", () => {
  it("ne fabrique qu'un contexte, quel que soit le nombre d'écrans", () => {
    const fakes = useFakeGl();
    const first = acquireGl();
    const second = acquireGl();
    expect(second).toBe(first);
    expect(fakes.built()).toBe(1);
    expect(first.users).toBe(2);
    expect(first.canvas).toBe(fakes.canvas as unknown as HTMLCanvasElement);
  });

  it("pose les réglages globaux une seule fois", () => {
    const fakes = useFakeGl();
    acquireGl();
    acquireGl();
    expect(fakes.renderer.pixelRatio).toBe(1); // pas de `window` sous Node
    expect(fakes.renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(fakes.renderer.toneMapping).toBe(THREE.NoToneMapping);
    // Les ombres restent allumées pour les deux écrans : les rebasculer
    // obligerait Three.js à recompiler tous les matériaux.
    expect(fakes.renderer.shadowMap.enabled).toBe(true);
    expect(fakes.renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(fakes.renderer.clearColor).toBe(0x0b0f14);
  });

  it("garde le contexte quand le dernier écran le rend, mais détache le canevas", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    const container = host();
    gl.attach(asElement(container));
    expect(gl.users).toBe(1);

    gl.release();
    expect(gl.users).toBe(0);
    expect(fakes.canvas.parent).toBe(null);
    expect(gl.container).toBe(null);

    // Un écran qui revient retrouve le **même** renderer : c'est tout l'objet
    // du module, ne jamais recréer de contexte.
    const again = acquireGl();
    expect(again).toBe(gl);
    expect(fakes.built()).toBe(1);
  });

  it("ne descend pas sous zéro utilisateur", () => {
    useFakeGl();
    const gl = acquireGl();
    gl.release();
    gl.release();
    expect(gl.users).toBe(0);
  });

  it("attache sans effet quand c'est déjà le bon conteneur (StrictMode)", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    const container = host();
    gl.attach(asElement(container));
    gl.attach(asElement(container));
    expect(container.appendCalls).toBe(1);
    expect(container.children).toEqual([fakes.canvas]);
    expect(gl.container).toBe(asElement(container));
  });

  it("rend le canevas réutilisable : détacher puis rattacher ailleurs le déplace", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    const colony = host();
    const globe = host();

    gl.attach(asElement(colony));
    gl.detach();
    expect(fakes.canvas.parent).toBe(null);
    expect(colony.children).toEqual([]);

    gl.attach(asElement(globe));
    expect(globe.children).toEqual([fakes.canvas]);
    expect(gl.container).toBe(asElement(globe));

    // Sans détacher : `attach` déplace, il ne duplique pas.
    gl.attach(asElement(colony));
    expect(globe.children).toEqual([]);
    expect(colony.children).toEqual([fakes.canvas]);
  });

  it("ignore un détachement demandé par l'écran qui n'a plus le canevas", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    const colony = host();
    const globe = host();

    gl.attach(asElement(colony));
    gl.attach(asElement(globe));
    // La colonie range ses affaires après coup : elle ne doit pas voler le
    // canevas au globe qui vient de le prendre.
    gl.detach(asElement(colony));
    expect(gl.container).toBe(asElement(globe));
    expect(globe.children).toEqual([fakes.canvas]);
  });

  it("retaille le tampon de rendu au conteneur, et prévient les écrans", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    const sizes: Array<[number, number]> = [];
    const off = gl.onResize((w, h) => sizes.push([w, h]));

    const container = host();
    container.clientWidth = 1024;
    container.clientHeight = 768;
    gl.attach(asElement(container));
    expect(fakes.renderer.sizes.at(-1)).toEqual([1024, 768]);
    expect(sizes.at(-1)).toEqual([1024, 768]);

    // Taille imposée : c'est celle qui passe, sans remesurer.
    gl.resize(640, 480);
    expect(fakes.renderer.sizes.at(-1)).toEqual([640, 480]);
    expect(sizes.at(-1)).toEqual([640, 480]);

    off();
    gl.resize(320, 240);
    expect(sizes.at(-1)).toEqual([640, 480]);
    expect(fakes.renderer.sizes.at(-1)).toEqual([320, 240]);
  });

  it("ne retaille rien tant qu'aucun écran ne porte le canevas", () => {
    const fakes = useFakeGl();
    const gl = acquireGl();
    fakes.renderer.sizes.length = 0;
    gl.resize();
    expect(fakes.renderer.sizes).toEqual([]);
  });

  it("marque la perte de contexte et prévient à la restauration", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakes = useFakeGl();
    const gl = acquireGl();
    let restored = 0;
    const off = gl.onRestored(() => {
      restored += 1;
    });

    expect(gl.contextLost).toBe(false);
    fakes.canvas.fire("webglcontextlost");
    // Les écrans lisent ce drapeau pour cesser de dessiner dans un contexte mort.
    expect(gl.contextLost).toBe(true);
    expect(restored).toBe(0);
    expect(warn).toHaveBeenCalled();

    fakes.canvas.fire("webglcontextrestored");
    expect(gl.contextLost).toBe(false);
    expect(restored).toBe(1);

    off();
    fakes.canvas.fire("webglcontextlost");
    fakes.canvas.fire("webglcontextrestored");
    expect(restored).toBe(1);
  });
});

describe("disposeTree", () => {
  it("rend géométries et matériaux de tout le sous-arbre, textures exclues", () => {
    const texture = new THREE.Texture();
    const disposed: string[] = [];
    texture.addEventListener("dispose", () => disposed.push("texture"));

    const root = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.addEventListener("dispose", () => disposed.push("geometry"));
    const material = new THREE.MeshBasicMaterial({ map: texture });
    material.addEventListener("dispose", () => disposed.push("material"));
    root.add(new THREE.Mesh(geometry, material));

    disposeTree(root);

    // Les textures sont mutualisées (catalogue de props, étiquettes de nom) :
    // elles appartiennent à qui les a créées, pas à la scène.
    expect(disposed).toEqual(["geometry", "material"]);
  });

  it("épargne la géométrie interne partagée par tous les `Sprite`", () => {
    const material = new THREE.SpriteMaterial();
    const sprite = new THREE.Sprite(material);
    let geometries = 0;
    let materials = 0;
    sprite.geometry.addEventListener("dispose", () => {
      geometries += 1;
    });
    material.addEventListener("dispose", () => {
      materials += 1;
    });
    const root = new THREE.Group();
    root.add(sprite);

    disposeTree(root);

    // Three.js n'a qu'une géométrie de sprite pour toute la page : la rendre
    // retirerait du GPU les étiquettes des écrans encore ouverts.
    expect(geometries).toBe(0);
    expect(materials).toBe(1);
  });

  it("rend aussi les objets qui ont leur propre `dispose`", () => {
    const root = new THREE.Group();
    const instanced = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      4,
    );
    let count = 0;
    instanced.addEventListener("dispose", () => {
      count += 1;
    });
    root.add(instanced);
    disposeTree(root);
    expect(count).toBe(1);
  });
});
