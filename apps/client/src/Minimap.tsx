/**
 * Mini-carte : aperçu 2D en bas à droite de l'écran de colonie, pour ne pas
 * perdre ses colons, ses bêtes marquées ni les raids qui arrivent par un bord
 * de la carte 128×128. Un `<canvas>` 2D — jamais WebGL, le contexte est
 * unique et partagé avec la scène 3D (`render/gl.ts`).
 *
 * Deux couches, à deux rythmes très différents :
 * - le **fond** (terrain + éléments), peint une fois dans un canevas caché
 *   par `setMap`, recalculé seulement quand la carte change (même rappel que
 *   `Renderer.setMap`, voir `App.tsx`) ;
 * - **par-dessus**, à chaque rafraîchissement du HUD (~500 ms, jamais à
 *   chaque frame) : pawns, cases en feu et rectangle de la vue caméra,
 *   redessinés par `update` sans reconstruire le fond.
 *
 * Purement imperative comme `Renderer` : `App.tsx` pousse les données par la
 * ref (`MinimapHandle`), rien ici ne duplique l'état du jeu en React — seul
 * le repli (bouton « − ») est un état local, persisté dans `localStorage`.
 */

import { forwardRef, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { clampRect, MINIMAP_SCALE, paintBackground, pixelToTile, type Rect } from "./minimapPaint";
import { ANIMAL_STRIDE, FACTION } from "./render/terrain";
import { FIRE_OUTER_COLOR, LIVESTOCK_COLLAR_COLOR, PAWN_STRIDE, RAIDER_COLOR, TRADER_COLOR } from "./render/Renderer";

/** Clé `localStorage` du repli, protégée par try/catch (mode privé, quota). */
const COLLAPSE_KEY = "rimlike.minimap.collapsed.v1";

/** Colons : blanc, pas la couleur par id du rendu 3D (mission §2). */
const COLONIST_COLOR = 0xffffff;
/** Bête sauvage : verte, sans équivalent dans `Renderer.ts` (`ANIMAL_COLORS` varie par espèce). */
const WILD_ANIMAL_COLOR = 0x4caf50;
/** Diamètre d'une pastille de pawn, en pixels affichés. */
const DOT_SIZE = 2;

export interface MinimapHandle {
  /** (Re)peint le fond. À appeler seulement quand `mapVersion` change (voir l'en-tête). */
  setMap(width: number, height: number, tiles: Uint8Array, features: Uint8Array): void;
  /**
   * Redessine pawns, feu et rectangle de vue par-dessus le fond déjà peint.
   * `fire` et `view` peuvent être `null` (aucun incendie / caméra pas encore
   * placée) : rien de plus n'est alors tracé pour cette couche.
   */
  update(pawns: Int32Array, animals: Int32Array, fire: Uint8Array | null, view: Rect | null): void;
}

export interface MinimapProps {
  /** Centre la caméra sur la case pointée (`Renderer.focusOn`), sans changer le zoom. */
  readonly onFocus: (x: number, y: number) => void;
}

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export const Minimap = forwardRef<MinimapHandle, MinimapProps>(function Minimap({ onFocus }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Fond peint une fois par `setMap`, caché : jamais affiché directement. */
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  /** Ids de bêtes de la colonie du dernier `update` : `Set` réutilisé, jamais réalloué. */
  const livestockIdsRef = useRef<Set<number>>(new Set());
  const lastPawnsRef = useRef<Int32Array>(new Int32Array(0));
  const lastFireRef = useRef<Uint8Array | null>(null);
  const lastViewRef = useRef<Rect | null>(null);
  const draggingRef = useRef(false);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false; // stockage indisponible : dépliée par défaut, comme au premier lancement
    }
  });

  /** Repeint pawns, feu et rectangle de vue depuis les dernières valeurs reçues (`update`, `setMap`). */
  const redraw = () => {
    const canvas = canvasRef.current;
    const bg = bgRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || !bg || width === 0 || height === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bg, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    const scaleX = canvas.width / width;
    const scaleY = canvas.height / height;

    const fire = lastFireRef.current;
    if (fire) {
      ctx.fillStyle = hexColor(FIRE_OUTER_COLOR);
      for (let i = 0; i < fire.length; i++) {
        if (fire[i] === 0) continue;
        const x = i % width;
        const y = Math.floor(i / width);
        ctx.fillRect(x * scaleX, y * scaleY, Math.ceil(scaleX), Math.ceil(scaleY));
      }
    }

    const livestockIds = livestockIdsRef.current;
    const pawns = lastPawnsRef.current;
    for (let o = 0; o + PAWN_STRIDE <= pawns.length; o += PAWN_STRIDE) {
      const id = pawns[o];
      const x = pawns[o + 1] / 256;
      const y = pawns[o + 2] / 256;
      const faction = pawns[o + 10];
      const color =
        faction === FACTION.Raider
          ? RAIDER_COLOR
          : faction === FACTION.Trader
            ? TRADER_COLOR
            : faction === FACTION.Animal
              ? WILD_ANIMAL_COLOR
              : livestockIds.has(id)
                ? LIVESTOCK_COLLAR_COLOR
                : COLONIST_COLOR;
      ctx.fillStyle = hexColor(color);
      ctx.fillRect(x * scaleX - DOT_SIZE / 2, y * scaleY - DOT_SIZE / 2, DOT_SIZE, DOT_SIZE);
    }

    const view = lastViewRef.current;
    if (view) {
      const clamped = clampRect(view, width, height);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        clamped.x0 * scaleX,
        clamped.y0 * scaleY,
        Math.max(1, (clamped.x1 - clamped.x0) * scaleX),
        Math.max(1, (clamped.y1 - clamped.y0) * scaleY),
      );
    }
  };

  useImperativeHandle(ref, () => ({
    setMap(width, height, tiles, features) {
      sizeRef.current = { width, height };
      let bg = bgRef.current;
      if (!bg) {
        bg = document.createElement("canvas");
        bgRef.current = bg;
      }
      bg.width = width;
      bg.height = height;
      const ctx = bg.getContext("2d");
      if (!ctx) return;
      const image = ctx.createImageData(width, height);
      paintBackground(width, height, tiles, features, image.data);
      ctx.putImageData(image, 0, 0);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = Math.round(width * MINIMAP_SCALE);
        canvas.height = Math.round(height * MINIMAP_SCALE);
      }
      redraw();
    },
    update(pawns, animals, fire, view) {
      lastPawnsRef.current = pawns;
      lastFireRef.current = fire;
      lastViewRef.current = view;
      const ids = livestockIdsRef.current;
      ids.clear();
      for (let o = 0; o + ANIMAL_STRIDE <= animals.length; o += ANIMAL_STRIDE) ids.add(animals[o]);
      redraw();
    },
  }));

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* stockage indisponible : le repli ne survit pas au rechargement */
      }
      return next;
    });
  };

  /** Case pointée par l'événement, dans le repère de la carte (`pixelToTile`). */
  const focusFromEvent = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const { width, height } = sizeRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const r = canvas.getBoundingClientRect();
    const scaleX = canvas.width / width;
    const scaleY = canvas.height / height;
    const px = ((e.clientX - r.left) / r.width) * canvas.width;
    const py = ((e.clientY - r.top) / r.height) * canvas.height;
    const tx = Math.max(0, Math.min(width - 1, pixelToTile(px, scaleX)));
    const ty = Math.max(0, Math.min(height - 1, pixelToTile(py, scaleY)));
    onFocus(tx + 0.5, ty + 0.5);
  };

  return (
    <div className="minimap">
      <button
        className="minimap-toggle"
        onClick={toggle}
        title={collapsed ? "Déplier la mini-carte" : "Replier la mini-carte"}
      >
        {collapsed ? "+" : "−"}
      </button>
      {!collapsed && (
        <canvas
          ref={canvasRef}
          className="minimap-canvas"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button !== 0) return; // clic droit : rien (mission §2)
            draggingRef.current = true;
            focusFromEvent(e);
          }}
          onPointerMove={(e) => {
            if (!draggingRef.current) return;
            focusFromEvent(e);
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
          onPointerLeave={() => {
            draggingRef.current = false;
          }}
        />
      )}
    </div>
  );
});
