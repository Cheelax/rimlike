import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";

/** Couleurs par terrain, indexées comme `sim::Terrain`. */
const TERRAIN_COLORS = [0x2c6fb0, 0xd8c88a, 0x6aa84f, 0x8b8b8b, 0x5b9a3c];
const TERRAIN_ROCK = 3;
const TERRAIN_TREE = 4;

/**
 * Vue du dessus pseudo-3D : caméra orthographique inclinée, éclairage
 * directionnel avec ombres. Ne connaît que des tableaux de terrain.
 */
export class Renderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: MapControls;
  private readonly sun: THREE.DirectionalLight;
  private mapMeshes: THREE.Object3D[] = [];
  private readonly onResize = () => this.resize();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x0b0f14);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableRotate = false;
    this.controls.screenSpacePanning = false;
    this.controls.minZoom = 0.4;
    this.controls.maxZoom = 8;
    this.controls.zoomToCursor = true;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun, this.sun.target);

    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  /** (Re)construit la carte. Instancié : une draw call par type d'objet. */
  setMap(width: number, height: number, tiles: Uint8Array): void {
    for (const m of this.mapMeshes) this.scene.remove(m);
    this.mapMeshes = [];

    const floorGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const floor = new THREE.InstancedMesh(floorGeo, new THREE.MeshLambertMaterial(), width * height);
    floor.receiveShadow = true;

    let rocks = 0;
    let trees = 0;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === TERRAIN_ROCK) rocks++;
      else if (tiles[i] === TERRAIN_TREE) trees++;
    }
    const rockMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.5, 1),
      new THREE.MeshLambertMaterial({ color: 0x7a7a7a }),
      Math.max(rocks, 1),
    );
    const treeMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.35, 1.1, 6),
      new THREE.MeshLambertMaterial({ color: 0x2f7a2f }),
      Math.max(trees, 1),
    );
    rockMesh.castShadow = rockMesh.receiveShadow = true;
    treeMesh.castShadow = treeMesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    let ri = 0;
    let ti = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = tiles[i];
        m.makeTranslation(x + 0.5, 0, y + 0.5);
        floor.setMatrixAt(i, m);
        floor.setColorAt(i, color.setHex(TERRAIN_COLORS[t] ?? 0xff00ff));
        if (t === TERRAIN_ROCK) {
          rockMesh.setMatrixAt(ri++, m.makeTranslation(x + 0.5, 0.25, y + 0.5));
        } else if (t === TERRAIN_TREE) {
          treeMesh.setMatrixAt(ti++, m.makeTranslation(x + 0.5, 0.55, y + 0.5));
        }
      }
    }
    rockMesh.count = rocks;
    treeMesh.count = trees;
    floor.instanceMatrix.needsUpdate = true;
    if (floor.instanceColor) floor.instanceColor.needsUpdate = true;
    rockMesh.instanceMatrix.needsUpdate = true;
    treeMesh.instanceMatrix.needsUpdate = true;

    this.mapMeshes = [floor, rockMesh, treeMesh];
    this.scene.add(...this.mapMeshes);

    this.frame(width, height);
  }

  /** Place la caméra et le soleil pour cadrer la carte. */
  private frame(width: number, height: number): void {
    const cx = width / 2;
    const cz = height / 2;
    const elevation = THREE.MathUtils.degToRad(55);
    const dist = 200;
    this.camera.position.set(cx, Math.sin(elevation) * dist, cz + Math.cos(elevation) * dist);
    this.camera.lookAt(cx, 0, cz);
    this.controls.target.set(cx, 0, cz);
    this.controls.update();

    this.sun.position.set(cx - width * 0.4, Math.max(width, height) * 0.8, cz - height * 0.3);
    this.sun.target.position.set(cx, 0, cz);
    const half = Math.max(width, height) * 0.75;
    const sc = this.sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = Math.max(width, height) * 3;
    sc.updateProjectionMatrix();
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
