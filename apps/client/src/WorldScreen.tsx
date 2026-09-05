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

import { useEffect, useMemo, useRef, useState } from "react";
import type { Caravan, Settlement } from "@rimlike/protocol";
import { BIOME_NAMES, findRoute, movementCost, type Tile, type World } from "@rimlike/world";
import { formatHours } from "./CaravanPanel";
import type { IdentitySummary, WorldClientState } from "./net/WorldClient";
import { GlobeRenderer } from "./render/GlobeRenderer";
import { ITEM_NAMES } from "./render/terrain";

/** Déplacement au-delà duquel un relâchement n'est plus un clic. */
const CLICK_TOLERANCE_PX = 5;

/** Liste vide stable : une nouvelle à chaque rendu rebâtirait le calque des colonies. */
const NO_SETTLEMENTS: readonly Settlement[] = Object.freeze([]);
/** Idem pour les caravanes : le calque du globe ne se rebâtit qu'au changement. */
const NO_CARAVANS: readonly Caravan[] = Object.freeze([]);

/** Une caravane s'annule tant qu'elle n'a pas fait la moitié du trajet (§12.5). */
const CANCEL_LIMIT = 0.5;

/** Ordre passé au crochet de dev pour expédier une caravane sans souris. */
export interface CaravanOrder {
  readonly pawnIds: readonly number[];
  /** Marchandises, `[kind, count]` avec `kind` l'index de `ITEM_NAMES`. */
  readonly items: readonly (readonly [number, number])[];
  readonly toTile: number;
}

/** Ce que le résumé d'une caravane donne à lire : « 3 colons, 40 bois ». */
export function describeCargo(caravan: Caravan): string {
  const parts: string[] = [];
  if (caravan.summary.pawns > 0) {
    parts.push(`${caravan.summary.pawns} colon${caravan.summary.pawns > 1 ? "s" : ""}`);
  }
  for (const [kind, count] of caravan.summary.items) {
    parts.push(`${count} ${ITEM_NAMES[kind] ?? `genre ${kind}`}`);
  }
  return parts.length === 0 ? "convoi vide" : parts.join(", ");
}

/** Statut d'une caravane, en français. */
export function caravanStatusLabel(caravan: Caravan): string {
  switch (caravan.status) {
    case "travelling":
      return "en route";
    case "returning":
      return "fait demi-tour";
    case "arrived":
      return "arrivée, en attente de la colonie";
    case "delivered":
      return "livrée";
  }
}

/**
 * Heures de jeu restantes, déduites de l'avancement plutôt que d'une horloge :
 * `progress` et les deux dates viennent du même message, le client n'a pas
 * besoin de savoir quelle heure il est dans le monde (`docs/protocol.md` §12.4).
 */
export function remainingHours(caravan: Caravan): number {
  return Math.max(0, (1 - caravan.progress) * (caravan.arrivesAt - caravan.departedAt));
}

export interface WorldScreenProps {
  readonly world: World;
  readonly net: WorldClientState | null;
  /** Notre nom : un simple libellé d'affichage (`net.playerKey` fait autorité, §11.2). */
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
  /**
   * Mode « choisir la case d'arrivée » : la case de départ de la caravane en
   * préparation, ou `null` en navigation ordinaire. Le globe s'affiche alors
   * par-dessus la colonie, sans son panneau, et le clic vaut destination.
   */
  readonly pickingFrom?: number | null;
  readonly onPickTile?: (tile: number) => void;
  readonly onCancelPick?: () => void;
  /** Itinéraire déjà choisi, tracé sur le globe hors mode sélection. */
  readonly routePreview?: readonly number[] | null;
  /** Rappelle une de nos caravanes (bouton « Annuler » du panneau). */
  readonly onCancelCaravan?: (id: string) => void;
  /**
   * Expédie une caravane de bout en bout : réservé au crochet de dev
   * (`window.__rimlike.world.sendCaravan`). L'interface, elle, passe par le
   * panneau Caravane de la colonie.
   */
  readonly onSendCaravan?: (order: CaravanOrder) => Promise<unknown>;
  /**
   * Résumé sans risque de l'identité stockée (crochet de dev) : jamais le
   * jeton en clair, seulement sa longueur (`net/identity.ts`).
   */
  readonly describeIdentity?: () => IdentitySummary | null;
  /** Oublie l'identité stockée pour ce serveur (crochet de dev, pour tester `bad_token`). */
  readonly onForgetIdentity?: () => void;
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
  pickingFrom = null,
  onPickTile,
  onCancelPick,
  routePreview = null,
  onCancelCaravan,
  onSendCaravan,
  describeIdentity,
  onForgetIdentity,
}: WorldScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [hoveredCaravan, setHoveredCaravan] = useState<string | null>(null);
  /** Miroir synchrone de la sélection : le crochet de dev le lit sans passer par React. */
  const selectedRef = useRef<number | null>(null);
  /**
   * Le mode sélection lu par les écouteurs souris, montés une fois pour
   * toutes : un `useEffect` par changement de mode recréerait le globe.
   */
  const pickRef = useRef<{ from: number | null; onPick: ((tile: number) => void) | undefined }>({
    from: null,
    onPick: undefined,
  });
  pickRef.current = { from: pickingFrom, onPick: onPickTile };

  const settlements = net?.settlements ?? NO_SETTLEMENTS;
  const caravans = net?.caravans ?? NO_CARAVANS;
  const byTile = new Map<number, Settlement>(settlements.map((s) => [s.tile, s]));
  /**
   * Notre clé publique et stable (`docs/protocol.md` §11.2) : c'est elle qui
   * fait autorité pour l'appartenance, jamais notre nom (qu'un autre joueur
   * pourrait tout aussi bien porter).
   */
  const myKey = net?.playerKey ?? null;
  /**
   * Tous les joueurs déjà vus par le monde, une entrée par clé — les
   * caravanes partent désormais de la connexion **monde** elle-même
   * (`WorldClient.sendDepart`, voir `docs/protocol.md` §12.7), qui porte déjà
   * la bonne clé : plus besoin de dédoublonner par nom comme en v1.
   */
  const players = net?.players ?? [];
  const onlinePlayers = players.filter((p) => p.online);

  const select = (tile: number | null) => {
    selectedRef.current = tile;
    setSelected(tile);
  };

  // --- Le globe : créé une fois, gardé monté tant qu'on est dans le monde ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new GlobeRenderer(canvas, world, {
      onHover: (tile) => setHovered(tile),
      onHoverCaravan: (id) => setHoveredCaravan(id),
    });
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
      const tile = renderer.pickAt(e.clientX, e.clientY) ?? start.tile;
      const pick = pickRef.current;
      if (pick.from !== null) {
        // Mode « choisir la case d'arrivée » : le clic vaut destination, il ne
        // change pas la case sélectionnée du panneau Monde. Ni l'océan ni la
        // case de départ elle-même (que le serveur refuse, `caravan_same_tile`)
        // ne sont des destinations.
        if (tile !== null && tile !== pick.from && movementCost(world.tiles[tile].biome) !== null) {
          pick.onPick?.(tile);
        }
        return;
      }
      select(tile);
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
    rendererRef.current?.setSettlements(settlements, myKey);
    // `settlements` est remplacé en entier à chaque diffusion du serveur.
  }, [settlements, myKey]);

  useEffect(() => {
    rendererRef.current?.setCaravans(caravans, myKey);
    // Idem : `world_caravans` porte la liste complète, à chaque tick du monde.
  }, [caravans, myKey]);

  /**
   * Itinéraire prévisualisé. En mode sélection il suit le survol — le joueur
   * voit la route et sa durée avant de cliquer ; sinon c'est celui que la
   * caravane en préparation a déjà retenu.
   */
  const hoveredRoute = useMemo(() => {
    if (pickingFrom === null || hovered === null || hovered === pickingFrom) return null;
    if (world.tiles[hovered] === undefined || movementCost(world.tiles[hovered].biome) === null) return null;
    return findRoute(world, pickingFrom, hovered);
  }, [world, pickingFrom, hovered]);

  useEffect(() => {
    const preview = pickingFrom !== null ? (hoveredRoute?.tiles ?? null) : routePreview;
    rendererRef.current?.setRoutePreview(preview ?? null);
  }, [pickingFrom, hoveredRoute, routePreview]);

  // --- Crochet de dev : window.__rimlike.world ---
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = (tile?: number) => tile ?? selectedRef.current;
    const api = {
      get state() {
        return {
          phase: net?.phase ?? "connecting",
          name,
          /** Notre clé publique et stable (`docs/protocol.md` §11.2), `null` avant `world_welcome`. */
          playerKey: net?.playerKey ?? null,
          players: net?.players ?? [],
          settlements: net?.settlements ?? [],
          caravans: net?.caravans ?? [],
          selected: selectedRef.current,
          visible,
          seed: world.seed,
          subdivisions: world.subdivisions,
          tiles: world.tiles.length,
          lastError: net?.lastError ?? null,
        };
      },
      /**
       * Résumé sans risque de l'identité stockée pour ce serveur : la clé
       * publique et la longueur du jeton, jamais sa valeur (`net/identity.ts`).
       */
      get identity() {
        return describeIdentity?.() ?? null;
      },
      /**
       * Oublie l'identité stockée pour ce serveur : le prochain `world_join`
       * (typiquement après un rechargement de page) repart sans jeton et crée
       * un nouveau joueur — de quoi éprouver `bad_token` sans toucher à
       * `localStorage` à la main.
       */
      forget() {
        onForgetIdentity?.();
      },
      /** Les caravanes connues, telles que le serveur les diffuse. */
      get caravans() {
        return net?.caravans ?? [];
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
      /**
       * Itinéraire prévisualisé entre deux cases, sans rien envoyer :
       * `{ tiles, hours }` ou `null` si aucune route terrestre.
       */
      route(fromTile: number, toTile: number) {
        return findRoute(world, fromTile, toTile);
      },
      /**
       * Expédie une caravane de bout en bout depuis la colonie en cours :
       * encodage de `FormCaravan`, attente du départ, `caravan_depart`, puis
       * `ClearDepartures`. Rend le manifeste expédié, résumé compris.
       *
       * Il faut être **dans** la salle de la case de départ et en être l'hôte
       * (`docs/protocol.md` §12.5) : sinon la promesse est rejetée tout de suite.
       */
      sendCaravan(order: CaravanOrder) {
        if (onSendCaravan === undefined) {
          return Promise.reject(new Error("aucune colonie en cours : entrez dans une salle tile-N"));
        }
        return onSendCaravan(order);
      },
      /** Rappelle une caravane, tant qu'elle n'a pas fait la moitié du trajet. */
      cancelCaravan(id: string) {
        if (onCancelCaravan === undefined) throw new Error("connexion monde absente");
        onCancelCaravan(id);
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
  }, [
    net,
    name,
    visible,
    world,
    onSettle,
    onVisit,
    onAbandon,
    onBack,
    onSendCaravan,
    onCancelCaravan,
    describeIdentity,
    onForgetIdentity,
  ]);

  const hoveredTile = hovered === null ? null : world.tiles[hovered];
  const selectedTile = selected === null ? null : world.tiles[selected];
  const selectedSettlement = selected === null ? undefined : byTile.get(selected);
  const hoveredSettlement = hovered === null ? undefined : byTile.get(hovered);
  const hoveredConvoy = hoveredCaravan === null ? undefined : caravans.find((c) => c.id === hoveredCaravan);
  const picking = pickingFrom !== null;

  return (
    <>
      <canvas ref={canvasRef} className="globe" style={{ display: visible ? "block" : "none" }} />

      {visible && picking && (
        <div className="pick-banner">
          Choisissez la case d'arrivée · <b>Échap</b> pour annuler
          <div className="help">
            départ de la case {pickingFrom} ·{" "}
            {hoveredTile === null
              ? "survolez une case terrestre"
              : hoveredRoute === null
                ? `${BIOME_NAMES[hoveredTile.biome]} · pas de route terrestre`
                : `${BIOME_NAMES[hoveredTile.biome]} · ${hoveredRoute.tiles.length} case(s) · ${formatHours(hoveredRoute.hours)}`}
          </div>
          <button className="wide" onClick={() => onCancelPick?.()}>
            Annuler
          </button>
        </div>
      )}

      {visible && (hoveredTile !== null || hoveredConvoy !== undefined) && (
        // Une seule infobulle, suivie par le curseur : la caravane survolée
        // passe devant la case, c'est elle qu'on vise.
        <div ref={tooltipRef} className="globe-tip">
          {hoveredConvoy ? (
            <>
              <b>caravane de {hoveredConvoy.ownerName}</b>
              <span>
                case {hoveredConvoy.fromTile} → {hoveredConvoy.toTile}
              </span>
              <span>{describeCargo(hoveredConvoy)}</span>
              <span className="owner">
                {hoveredConvoy.status === "travelling" || hoveredConvoy.status === "returning"
                  ? `arrivée dans ${formatHours(remainingHours(hoveredConvoy))}`
                  : caravanStatusLabel(hoveredConvoy)}
              </span>
            </>
          ) : hoveredTile === null ? null : (
            <>
              <b>{BIOME_NAMES[hoveredTile.biome]}</b>
              <span>{coordinates(hoveredTile)}</span>
              {hoveredSettlement ? <span className="owner">colonie de {hoveredSettlement.ownerName}</span> : null}
            </>
          )}
        </div>
      )}

      {visible && !picking && (
        <>
          <div className="hud">
            <div>
              monde · graine <b>{world.seed}</b> · <b>{world.tiles.length}</b> cases · subdivision{" "}
              <b>{world.subdivisions}</b>
            </div>
            <div>
              <b>{settlements.length}</b> colonie{settlements.length > 1 ? "s" : ""} ·{" "}
              <b>{onlinePlayers.length}</b> joueur{onlinePlayers.length > 1 ? "s" : ""} en ligne ·{" "}
              {net?.phase === "connected" ? "connecté" : net?.phase === "closed" ? "déconnecté" : "connexion…"}
            </div>
            <div className="help">glisser : tourner · molette : zoom · clic : choisir une case</div>
          </div>

          <div className="world-panel">
            <div className="panel-title">Monde partagé</div>

            <div className="world-section">Joueurs ({players.length})</div>
            <ul className="lobby">
              {players.map((player) => (
                <li key={player.key} className={player.online ? "" : "offline"}>
                  {player.name}
                  {player.key === myKey ? " · vous" : ""}
                  {!player.online ? " · hors ligne" : ""}
                </li>
              ))}
              {players.length === 0 && <li className="empty">personne pour l'instant</li>}
            </ul>

            <div className="world-section">Colonies ({settlements.length})</div>
            <ul className="lobby">
              {settlements.map((settlement) => {
                const tile = world.tiles[settlement.tile];
                return (
                  <li key={settlement.tile} className={settlement.owner === myKey ? "mine" : ""}>
                    <button className="link" onClick={() => select(settlement.tile)}>
                      case {settlement.tile}
                    </button>{" "}
                    · {settlement.ownerName} · {tile === undefined ? "?" : BIOME_NAMES[tile.biome]}
                    <button className="small" onClick={() => onVisit(settlement.tile)}>
                      Visiter
                    </button>
                  </li>
                );
              })}
              {settlements.length === 0 && <li className="empty">aucune colonie sur ce globe</li>}
            </ul>

            <div className="world-section">Caravanes ({caravans.length})</div>
            <ul className="lobby">
              {caravans.map((caravan) => {
                const mine = caravan.owner === myKey;
                // Le serveur refuse l'annulation au-delà de la moitié : on
                // grise plutôt que d'encaisser un `caravan_too_late` (§12.7).
                const cancellable = mine && caravan.status === "travelling" && caravan.progress < CANCEL_LIMIT;
                return (
                  <li key={caravan.id} className={mine ? "mine" : ""}>
                    <button className="link" onClick={() => select(caravan.currentTile)}>
                      {caravan.fromTile} → {caravan.toTile}
                    </button>{" "}
                    · {caravan.ownerName} · {Math.round(caravan.progress * 100)} %
                    {mine && (
                      <button
                        className="small"
                        disabled={!cancellable}
                        title={cancellable ? "Faire demi-tour" : "Trop tard : plus de la moitié du trajet"}
                        onClick={() => onCancelCaravan?.(caravan.id)}
                      >
                        Annuler
                      </button>
                    )}
                    <div className="help">
                      {describeCargo(caravan)} · {caravanStatusLabel(caravan)}
                      {caravan.status === "travelling" || caravan.status === "returning"
                        ? ` · dans ${formatHours(remainingHours(caravan))}`
                        : ""}
                    </div>
                  </li>
                );
              })}
              {caravans.length === 0 && <li className="empty">aucune caravane en vol</li>}
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
                      colonie de <b>{selectedSettlement.ownerName}</b> · salle {selectedSettlement.room}
                    </div>
                  )}
                </div>
                {selectedSettlement ? (
                  <button className="wide primary" onClick={() => onVisit(selected)}>
                    {selectedSettlement.owner === myKey ? "Reprendre ma colonie" : "Visiter"}
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
