/**
 * Les outils de la barre (déplacés depuis `App.tsx` pour que `shortcuts.ts` en
 * tire l'aide des raccourcis sans jamais diverger de la vraie barre : une
 * seule liste, lue à la fois pour l'affichage et pour le gestionnaire de
 * `keydown`). Contenu inchangé, voir `AGENTS.md` (« Conventions côté
 * client ») et le commit qui a introduit chaque outil.
 */

export type Tool =
  | "select"
  | "chop"
  | "mine"
  | "harvest"
  | "stockpile"
  | "growing"
  | "wall"
  | "door"
  | "floor"
  | "bed"
  | "campfire"
  | "craftingSpot"
  | "researchBench"
  | "grave"
  | "spikeTrap"
  | "cancel";

export const TOOLS: {
  id: Tool;
  label: string;
  key: string;
  color: number;
  group: "orders" | "build";
  /** Coût affiché dans l'infobulle du bouton, à la place de « Touche X » (mission tombes : « 5 pierre »). */
  hint?: string;
}[] = [
  { id: "select", label: "Sélection", key: "S", color: 0xffffff, group: "orders" },
  { id: "chop", label: "Couper", key: "C", color: 0xff9a2e, group: "orders" },
  { id: "mine", label: "Miner", key: "M", color: 0xff9a2e, group: "orders" },
  // Touche H : Récolter, sauf si un animal est sélectionné, où elle bascule
  // la chasse à la place (voir `hKeyAction` et le gestionnaire de `keydown`).
  { id: "harvest", label: "Récolter", key: "H", color: 0xff9a2e, group: "orders" },
  { id: "stockpile", label: "Stockage", key: "Z", color: 0x4a90d9, group: "orders" },
  { id: "growing", label: "Culture", key: "G", color: 0x5cc25c, group: "orders" },
  { id: "wall", label: "Mur", key: "B", color: 0x4ad9ff, group: "build" },
  { id: "door", label: "Porte", key: "P", color: 0x4ad9ff, group: "build" },
  { id: "floor", label: "Sol", key: "O", color: 0x4ad9ff, group: "build" },
  { id: "bed", label: "Lit", key: "L", color: 0x4ad9ff, group: "build" },
  { id: "campfire", label: "Feu", key: "F", color: 0x4ad9ff, group: "build" },
  { id: "craftingSpot", label: "Poste", key: "A", color: 0x4ad9ff, group: "build" },
  // Aucune lettre libre ne rappelle « établi » ou « recherche » (E est prise
  // par la rotation de caméra, R par le panneau Recherche) : pas de raccourci
  // clavier, un bouton suffit, comme pour la tombe ci-dessous.
  { id: "researchBench", label: "Établi de recherche", key: "", color: 0x4ad9ff, group: "build", hint: "15 bois" },
  // Aucune lettre libre ne rappelle « tombe » (T, O, G... sont déjà pris) :
  // pas de raccourci clavier, un bouton suffit (mission tombes §1).
  { id: "grave", label: "Tombe", key: "", color: 0x4ad9ff, group: "build", hint: "5 pierre" },
  // Aucune lettre libre ne rappelle « piège » (P est pris par la porte, T par
  // le matériau) : pas de raccourci clavier, un bouton suffit, comme la tombe
  // et l'établi de recherche ci-dessus.
  {
    id: "spikeTrap", label: "Piège à pointes", key: "", color: 0x4ad9ff, group: "build",
    hint: "5 bois · blesse le premier ennemi qui marche dessus, vos colons le contournent",
  },
  { id: "cancel", label: "Annuler", key: "X", color: 0xff4040, group: "orders" },
];
