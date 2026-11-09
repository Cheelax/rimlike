/** Présentation du tampon du sim : aucune décision de combat côté client.
 * [posture (0 libre, 1 tenir, 2 veille), hostiles, préavis en ticks,
 *  puissance alliée, puissance ennemie, premier id hostile].
 */
export interface RaidNotice {
  readonly label: string;
  readonly posture: string;
  readonly detail: string;
  readonly target: number | null;
}

export function raidNotice(raw: ArrayLike<number>, ticksPerDay: number): RaidNotice | null {
  const count = raw[1] ?? 0;
  if (count <= 0) return null;
  const warning = raw[2] ?? 0;
  const minutes = ticksPerDay > 0 ? Math.ceil(warning * 1440 / ticksPerDay) : 0;
  const timing = minutes > 0 ? ` · départ dans ${minutes} min de jeu` : "";
  const posture = raw[0] === 2 ? "Veille · portes fermées"
    : raw[0] === 1 ? "Défense à la porte" : "Colonie exposée";
  const detail = raw[0] === 2
    ? "Les colons rentrent et restent à l’abri. Les ressources et les animaux restés dehors sont exposés au pillage."
    : raw[0] === 1
      ? "Les colons se rassemblent à l’intérieur de l’entrée et défendent sans poursuivre dehors."
      : "Aucune enceinte ne protège la colonie. Les colons se défendent là où ils se trouvent.";
  return {
    label: `${warning > 0 ? "Raid repéré" : "Raid en cours"} · ${count} ennemi${count > 1 ? "s" : ""}${timing}`,
    posture,
    detail: `${detail} Vos ordres de déplacement et d’attaque restent prioritaires. Cliquer pour observer la bande.`,
    target: raw.length > 5 && raw[5] !== 0xffffffff ? raw[5] : null,
  };
}
