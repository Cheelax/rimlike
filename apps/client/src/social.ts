/**
 * Relations entre colons (`crates/sim/src/social.rs`) : logique pure, sans
 * sim ni rendu — décodage de `pawn_opinions(id)` et qualificatif d'un avis,
 * affichés par la section « Relations » du panneau du colon (`App.tsx`).
 *
 * Contrat : `pawn_opinions(id)` renvoie `[autre, avis] × n`, trié par id de
 * l'autre colon, avis dans `-100..=100`, vide pour un id inconnu ou un
 * non-colon (`AGENTS.md`, `social::Opinion`).
 */

/** Un avis décodé : l'id de l'autre colon, et l'avis porté sur lui. */
export interface Opinion {
  readonly other: number;
  readonly value: number;
}

/**
 * Décode le tampon plat `[autre, avis] × n` renvoyé par `pawn_opinions`. Un
 * tampon impair est coupé proprement (la dernière valeur seule est ignorée),
 * comme les autres décodages ponctuels du client (`pawnInjuries`).
 */
export function decodeOpinions(buffer: ArrayLike<number>): Opinion[] {
  const out: Opinion[] = [];
  for (let o = 0; o + 2 <= buffer.length; o += 2) {
    out.push({ other: buffer[o], value: buffer[o + 1] });
  }
  return out;
}

/**
 * Qualificatif d'un avis, sur les seuils de `crates/sim/src/social.rs`
 * (`FRIEND_OPINION` = 50, `RIVAL_OPINION` = −50) : ami ≥ 50, apprécié 20..49,
 * toléré −19..19, mal vu −49..−20, rival ≤ −50.
 */
export function opinionLabel(value: number): string {
  if (value >= 50) return "ami";
  if (value >= 20) return "apprécié";
  if (value >= -19) return "toléré";
  if (value >= -49) return "mal vu";
  return "rival";
}

/** Trie par avis décroissant : les amis en tête, les rivaux en fin de liste. */
export function sortOpinions(opinions: readonly Opinion[]): Opinion[] {
  return [...opinions].sort((a, b) => b.value - a.value);
}
