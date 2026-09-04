/**
 * L'écran Monde : le globe, le survol, la sélection d'une case, et le panneau
 * qui dit ce qu'on peut en faire.
 *
 * Ce composant ne parle pas au réseau : il reçoit l'état du `WorldClient`
 * (colonies, joueurs) et rend des rappels (`onSettle`, `onVisit`). La
 * connexion, elle, vit dans `App.tsx` et **survit** au passage dans une
 * colonie — c'est ce qui permet de revenir au monde sans retélécharger le
 * globe ni se reconnecter.
 *
 * Le composant reste monté pendant la partie, simplement masqué : le globe
 * représente ~40 000 triangles et un contexte WebGL, autant ne pas les rebâtir
 * à chaque aller-retour.
 */

import { useEffect, useRef, useState } from "react";
import type { Settlement } from "@rimlike/protocol";
import { BIOME_NAMES, movementCost, type Tile, type World } from "@rimlike/world";
import type { WorldClientState } from "./net/WorldClient";
import { GlobeRenderer } from "./render/GlobeRenderer";

/** Déplacement au-delà duquel un relâchement n'est plus un clic. */
const CLICK_TOLERANCE_PX = 5;

/** Liste vide stable : une nouvelle à chaque rendu rebâtirait le calque des colonies. */
const NO_SETTLEMENTS: readonly Settlement[] = Object.freeze([]);

export interface WorldScreenProps {
  readonly world: World;
  readonly net: WorldClientState | null;
  /** Notre nom : sert à distinguer nos colonies de celles des autres. */
  readonly name: string;
  /** Faux pendant qu'on joue une colonie : le globe reste monté mais caché. */
  readonly visible: boolean;
  readonly onSettle: (tile: number) => void;
  readonly onVisit: (tile: number) => void;
  readonly onAbandon: (tile: number) => void;
  /** Revenir à l'écran Monde depuis une colonie (utilisé par le crochet de dev). */
  readonly onBack: () => void;
  /** Quitter le monde et revenir à l'accueil. */
  readonly onQuit: () => void;
}

/** Latitude et longitude d'une case, écrites comme sur une carte. */
function coordinates(tile: Tile): string {
  const ns = tile.lat >= 0 ? "N" : "S";
  const ew = tile.lon >= 0 ? "E" : "O";
  return `${Math.abs(tile.lat).toFixed(1)}° ${ns}, ${Math.abs(tile.lon).toFixed(1)}° ${ew}`;
}

/** Vrai si une colonie peut se poser là : terrestre (banquise comprise) et libre. */
function isLand(tile: Tile): boolean {
  return movementCost(tile.biome) !== null;
}

export function WorldScreen({
  world,
  net,
  name,
  visible,
  onSettle,
  onVisit,
  onAbandon,
  onBack,
  onQuit,
}: WorldScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  /** Miroir synchrone de la sélection : le crochet de dev le lit sans passer par React. */
  const selectedRef = useRef<number | null>(null);

  const settlements = net?.settlements ?? NO_SETTLEMENTS;
  const byTile = new Map<number, Settlement>(settlements.map((s) => [s.tile, s]));

  const select = (tile: number | null) => {
    selectedRef.current = tile;
    setSelected(tile);
  };

  // --- Le globe : créé une fois, gardé monté tant qu'on est dans le monde ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new GlobeRenderer(canvas, world, { onHover: (tile) => setHovered(tile) });
    rendererRef.current = renderer;
    let raf = 0;
    let disposed = false;
    const loop = () => {
      if (disposed) return;
      renderer.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    let down: { x: number; y: number; tile: number | null } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, tile: renderer.pickAt(e.clientX, e.clientY) };
    };
    const onPointerMove = (e: PointerEvent) => {
      renderer.setPointer(e.clientX, e.clientY);
      const tooltip = tooltipRef.current;
      // La position suit le curseur sans passer par React : un `setState` par
      // mouvement de souris rendrait tout le panneau soixante fois par seconde.
      if (tooltip) {
        tooltip.style.left = `${e.clientX + 14}px`;
        tooltip.style.top = `${e.clientY + 16}px`;
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (start === null) return;
      // Un glissé fait tourner le globe : ce n'est pas une sélection.
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_TOLERANCE_PX) return;
      select(renderer.pickAt(e.clientX, e.clientY) ?? start.tile);
    };
    const onPointerLeave = () => renderer.clearPointer();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [world]);

  // Le canevas masqué mesure 0 × 0 : il faut le remesurer au retour.
  useEffect(() => {
    if (visible) rendererRef.current?.resize();
  }, [visible]);

  useEffect(() => {
    rendererRef.current?.setSelected(selected);
  }, [selected]);

  useEffect(() => {
    rendererRef.current?.setSettlements(settlements, name);
    // `settlements` est remplacé en entier à chaque diffusion du serveur.
  }, [settlements, name]);

  // --- Crochet de dev : window.__rimlike.world ---
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = (tile?: number) => tile ?? selectedRef.current;
    const api = {
      get state() {
        return {
          phase: net?.phase ?? "connecting",
          name,
          players: net?.players ?? [],
          settlements: net?.settlements ?? [],
          selected: selectedRef.current,
          visible,
          seed: world.seed,
          subdivisions: world.subdivisions,
          tiles: world.tiles.length,
          lastError: net?.lastError ?? null,
        };
      },
      /** Sélectionne une case et l'amène au centre de l'écran. */
      select(tile: number) {
        select(tile);
        rendererRef.current?.focusTile(tile);
        return this.tile(tile);
      },
      /** Tout ce qu'on sait d'une case, y compris son propriétaire. */
      tile(id: number) {
        const t = world.tiles[id];
        if (t === undefined) return null;
        return {
          id,
          biome: BIOME_NAMES[t.biome],
          land: isLand(t),
          lat: t.lat,
          lon: t.lon,
          elevation: t.elevation,
          temperature: t.temperature,
          moisture: t.moisture,
          settlement: (net?.settlements ?? []).find((s) => s.tile === id) ?? null,
        };
      },
      /** Premières cases terrestres et libres du globe : de quoi s'installer sans souris. */
      freeLand(count = 5) {
        const taken = new Set((net?.settlements ?? []).map((s) => s.tile));
        const found: number[] = [];
        for (const t of world.tiles) {
          if (found.length >= count) break;
          if (isLand(t) && !taken.has(t.id)) found.push(t.id);
        }
        return found;
      },
      settle(tile?: number) {
        const id = target(tile);
        if (id === null) throw new Error("aucune case sélectionnée");
        onSettle(id);
        return id;
      },
      visit(tile?: number) {
        const id = target(tile);
        if (id === null) throw new Error("aucune case sélectionnée");
        onVisit(id);
        return id;
      },
      abandon(tile?: number) {
        const id = target(tile);
        if (id === null) throw new Error("aucune case sélectionnée");
        onAbandon(id);
        return id;
      },
      /** Quitte la colonie en cours et revient à l'écran Monde. */
      back: () => onBack(),
    };
    const hook = window as unknown as { __rimlike?: Record<string, unknown> };
    hook.__rimlike ??= {};
    hook.__rimlike.world = api;
    return () => {
      // Le crochet de la partie recopie `world` quand il s'installe : le
      // retirer ici évite qu'une API morte survive à l'écran Monde.
      if (hook.__rimlike?.world === api) delete hook.__rimlike.world;
    };
  }, [net, name, visible, world, onSettle, onVisit, onAbandon, onBack]);

  const hoveredTile = hovered === null ? null : world.tiles[hovered];
  const selectedTile = selected === null ? null : world.tiles[selected];
  const selectedSettlement = selected === null ? undefined : byTile.get(selected);
  const hoveredSettlement = hovered === null ? undefined : byTile.get(hovered);

  return (
    <>
      <canvas ref={canvasRef} className="globe" style={{ display: visible ? "block" : "none" }} />
      {visible && (
        <>
          <div className="hud">
            <div>
              monde · graine <b>{world.seed}</b> · <b>{world.tiles.length}</b> cases · subdivision{" "}
              <b>{world.subdivisions}</b>
            </div>
            <div>
              <b>{settlements.length}</b> colonie{settlements.length > 1 ? "s" : ""} ·{" "}
              <b>{net?.players.length ?? 0}</b> joueur{(net?.players.length ?? 0) > 1 ? "s" : ""} en ligne ·{" "}
              {net?.phase === "connected" ? "connecté" : net?.phase === "closed" ? "déconnecté" : "connexion…"}
            </div>
            <div className="help">glisser : tourner · molette : zoom · clic : choisir une case</div>
          </div>

          {hoveredTile && (
            <div ref={tooltipRef} className="globe-tip">
              <b>{BIOME_NAMES[hoveredTile.biome]}</b>
              <span>{coordinates(hoveredTile)}</span>
              {hoveredSettlement ? <span className="owner">colonie de {hoveredSettlement.owner}</span> : null}
            </div>
          )}

          <div className="world-panel">
            <div className="panel-title">Monde partagé</div>

            <div className="world-section">Joueurs ({net?.players.length ?? 0})</div>
            <ul className="lobby">
              {(net?.players ?? []).map((player, i) => (
                <li key={`${player}-${i}`}>
                  {player}
                  {player === name ? " · vous" : ""}
                </li>
              ))}
              {(net?.players.length ?? 0) === 0 && <li className="empty">personne pour l'instant</li>}
            </ul>

            <div className="world-section">Colonies ({settlements.length})</div>
            <ul className="lobby">
              {settlements.map((settlement) => {
                const tile = world.tiles[settlement.tile];
                return (
                  <li key={settlement.tile} className={settlement.owner === name ? "mine" : ""}>
                    <button className="link" onClick={() => select(settlement.tile)}>
                      case {settlement.tile}
                    </button>{" "}
                    · {settlement.owner} · {tile === undefined ? "?" : BIOME_NAMES[tile.biome]}
                    <button className="small" onClick={() => onVisit(settlement.tile)}>
                      Visiter
                    </button>
                  </li>
                );
              })}
              {settlements.length === 0 && <li className="empty">aucune colonie sur ce globe</li>}
            </ul>

            <div className="world-section">Case sélectionnée</div>
            {selectedTile === null || selected === null ? (
              <div className="help">Cliquez une case du globe pour la choisir.</div>
            ) : (
              <>
                <div className="world-tile">
                  <div>
                    <b>{BIOME_NAMES[selectedTile.biome]}</b> · case {selected}
                  </div>
                  <div className="help">{coordinates(selectedTile)}</div>
                  <div className="help">
                    {selectedTile.temperature.toFixed(1)} °C · humidité{" "}
                    {Math.round(selectedTile.moisture * 100)} % · élévation {selectedTile.elevation.toFixed(2)}
                  </div>
                  {selectedSettlement && (
                    <div className="help">
                      colonie de <b>{selectedSettlement.owner}</b> · salle {selectedSettlement.room}
                    </div>
                  )}
                </div>
                {selectedSettlement ? (
                  <button className="wide primary" onClick={() => onVisit(selected)}>
                    {selectedSettlement.owner === name ? "Reprendre ma colonie" : "Visiter"}
                  </button>
                ) : isLand(selectedTile) ? (
                  <button className="wide primary" onClick={() => onSettle(selected)}>
                    S'installer ici
                  </button>
                ) : (
                  <button className="wide" disabled>
                    Océan : impossible
                  </button>
                )}
              </>
            )}

            <div className="world-spacer" />
            <button className="wide" onClick={onQuit}>
              Quitter le monde
            </button>
          </div>
        </>
      )}
    </>
  );
}
