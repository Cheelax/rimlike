//! Équilibrage de la menace : ce que la difficulté et la richesse font à la
//! taille des bandes, et ce qu'une colonie en survit.
//!
//! Ces tests-là ne vérifient pas un mécanisme, ils **mesurent un réglage** :
//! chacun rejoue le même scénario sur plusieurs graines et compare des
//! moyennes, comme le demande `AGENTS.md` (« on mesure avant de régler »).
//! Ils encodent les objectifs chiffrés tirés des campagnes de
//! `crates/sim-cli/CAMPAIGN-FINDINGS.md` (§4 difficulté, §5 menace) :
//!
//! - la bande du tick 0 fait deux têtes, à trois colons, en normal ;
//! - une colonie trois fois plus riche au jour 30 reçoit des bandes au moins
//!   moitié plus grosses qu'au jour 5 ;
//! - en difficile, le premier raid ne fait pas plus de deux têtes et laisse à
//!   la colonie de quoi s'armer ;
//! - en difficile, la moitié des colonies passent le dixième jour.
//!
//! Les messages d'échec portent les chiffres mesurés : c'est ce qui sert à
//! régler, pas seulement à constater.

use sim::combat::{GRACE_DAYS, MAX_RAIDERS};
use sim::health::SEVERITY_MAX;
use sim::pawn::NEED_MAX;
use sim::storyteller::POINTS_PER_RAIDER;
use sim::{
    BodyPart, Command, Difficulty, EventKind, Faction, ItemKind, RaidKind, Sim, TICKS_PER_DAY,
};

const DAY: u64 = TICKS_PER_DAY as u64;
/// Carte des campagnes de mesure (`CAMPAIGN-FINDINGS.md`), en plus petit :
/// les points de menace ne dépendent pas de la taille de la carte, seules la
/// densité de bois et les distances de marche changent.
const SIZE: u32 = 48;

// ----------------------------------------------------------------------
// Outils
// ----------------------------------------------------------------------

/// Remet faim et repos au maximum : ces mesures-là regardent la menace, pas
/// la famine.
fn feed(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    for id in ids {
        if let Some(p) = s.pawn_mut(id) {
            p.hunger = NEED_MAX;
            p.rest = NEED_MAX;
        }
    }
}

fn raiders(s: &Sim) -> u32 {
    s.pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider)
        .count() as u32
}

fn colonists(s: &Sim) -> u32 {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count() as u32
}

/// Achève les pillards présents et laisse le sim les retirer : la bande
/// suivante ne peut entrer que la carte vide.
fn wipe_raiders(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider && p.is_alive())
        .map(|p| p.id)
        .collect();
    for id in ids {
        s.inflict_injury(id, BodyPart::Torso, SEVERITY_MAX);
    }
    s.step(&[]);
    s.step(&[]);
    assert_eq!(raiders(s), 0, "des pillards ont survécu au coup de grâce");
}

/// Case franchissable au centre de la carte : c'est là qu'on empile la
/// richesse.
fn center(s: &Sim) -> (u32, u32) {
    s.map()
        .nearest_passable(SIZE / 2, SIZE / 2)
        .expect("carte sans centre franchissable")
}

/// Colonie de `seed`, à la difficulté voulue, avec `wood` bois posés au
/// centre et `days` jours au compteur. L'avance rapide décale les échéances
/// du storyteller avec le reste (`Sim::fast_forward`) : la colonie a vraiment
/// vécu ces jours-là du point de vue de la menace, sans les jouer.
fn aged_colony(seed: u64, difficulty: Difficulty, days: u32, wood: u32) -> Sim {
    let mut s = Sim::new(seed, SIZE, SIZE);
    s.step(&[Command::SetDifficulty { level: difficulty }]);
    if wood > 0 {
        let (cx, cy) = center(&s);
        s.spawn_item(ItemKind::Wood, wood, cx, cy);
    }
    if days > 0 {
        s.fast_forward(TICKS_PER_DAY * days);
    }
    s
}

/// Moyenne en centièmes, sur des entiers : les tests d'équilibrage comparent
/// des moyennes, et le sim n'a pas le droit aux flottants.
fn mean_hundredths(values: &[u32]) -> u32 {
    if values.is_empty() {
        return 0;
    }
    let sum: u32 = values.iter().sum();
    sum * 100 / values.len() as u32
}

// ----------------------------------------------------------------------
// Le socle : la bande du premier jour
// ----------------------------------------------------------------------

/// Trois colons sans le sou, au tick 0, en normal : deux pillards, pas trois.
/// C'est ce que `first_raid_is_dangerous_but_survivable` (gameplay.rs)
/// calibre, et le point fixe autour duquel tout le reste se règle — la
/// vérification est ici pour qu'un réglage de la menace le casse **bruyamment**.
#[test]
fn la_bande_du_tick_zero_fait_deux_tetes() {
    for seed in 1..=8u64 {
        let mut s = Sim::new(seed, SIZE, SIZE);
        assert_eq!(colonists(&s), 3, "graine {seed} : colonie de départ");
        assert_eq!(s.wealth(), 300, "graine {seed} : richesse de départ");
        let points = s.threat_points();
        assert!(
            (2 * POINTS_PER_RAIDER..3 * POINTS_PER_RAIDER).contains(&points),
            "graine {seed} : {points} points au tick 0, hors de la fourchette \
             [{}, {}[ qui fait exactement deux têtes",
            2 * POINTS_PER_RAIDER,
            3 * POINTS_PER_RAIDER
        );
        s.trigger_raid_of(RaidKind::Rush);
        assert_eq!(raiders(&s), 2, "graine {seed} : bande du tick 0");
    }
}

// ----------------------------------------------------------------------
// §5 — la richesse doit peser
// ----------------------------------------------------------------------

/// Une colonie trois fois plus riche reçoit des bandes au moins moitié plus
/// grosses. L'échelle des deux scènes est **mesurée**, pas choisie : la
/// colonie du joueur scripté vaut 1 565 de richesse au jour 5 (campagne de 30
/// graines, `--days 5`), le triple fait ≈ 4 700.
///
/// Les bandes sont **forcées** (`trigger_raid_of`) : le plafond de la première
/// bande (`storyteller::FIRST_RAID_POINTS`) ne s'applique qu'au chemin
/// naturel, et ce qu'on mesure ici est la menace elle-même.
///
/// **Constat mesuré avant réglage** : 1,90 tête dans les deux scènes — un
/// tarif unique de 400 pour toute la richesse, écrasé par les 40 points de
/// chaque colon. C'est ce qui a fait scinder le terme en deux tranches
/// (`storyteller::WEALTH_RICH_FROM`).
#[test]
fn la_richesse_grossit_les_bandes() {
    /// Bois posé au jour 5 : 1 265 × 1 de valeur, plus 300 de colons = 1 565,
    /// la richesse mesurée d'une colonie de campagne au jour 5.
    const YOUNG_WOOD: u32 = 1_265;
    /// Le triple de richesse : 4 395 + 300 = 4 695.
    const RICH_WOOD: u32 = 4_395;
    const SEEDS: u64 = 20;

    // Trois colons valent 300 (`COLONIST_WEALTH`), un bois vaut 1 : la
    // richesse des deux scènes est connue d'avance, et vérifiée graine par
    // graine — la carte, elle, ne vaut rien (`feature_wealth` ignore la nature).
    let (young_wealth, rich_wealth) = (300 + YOUNG_WOOD, 300 + RICH_WOOD);
    assert!(
        rich_wealth >= 3 * young_wealth - young_wealth / 10,
        "la scène riche ({rich_wealth}) ne vaut pas trois fois la jeune ({young_wealth})"
    );

    let mut young = Vec::new();
    let mut rich = Vec::new();
    for seed in 1..=SEEDS {
        let mut a = aged_colony(seed, Difficulty::Normal, 5, YOUNG_WOOD);
        assert_eq!(
            a.wealth(),
            young_wealth,
            "graine {seed} : richesse au jour 5"
        );
        a.trigger_raid_of(RaidKind::Rush);
        young.push(raiders(&a));

        let mut b = aged_colony(seed, Difficulty::Normal, 30, RICH_WOOD);
        assert_eq!(
            b.wealth(),
            rich_wealth,
            "graine {seed} : richesse au jour 30"
        );
        b.trigger_raid_of(RaidKind::Rush);
        rich.push(raiders(&b));
    }

    let (y, r) = (mean_hundredths(&young), mean_hundredths(&rich));
    assert!(
        r * 100 >= y * 150,
        "bandes : {},{:02} tête au jour 5 (richesse {}), {},{:02} au jour 30 \
         (richesse {}) — il en faut au moins la moitié en plus",
        y / 100,
        y % 100,
        young_wealth,
        r / 100,
        r % 100,
        rich_wealth
    );
    assert!(
        rich.iter().all(|&n| n <= MAX_RAIDERS),
        "une bande dépasse le plafond : {rich:?}"
    );
}

// ----------------------------------------------------------------------
// §4 — la difficulté ne doit pas éteindre la colonie avant qu'elle s'arme
// ----------------------------------------------------------------------

/// Tick du premier raid **naturel** (celui du storyteller) et taille de la
/// bande, ou `None` si rien n'est entré dans les `max_days` jours.
fn first_natural_raid(seed: u64, difficulty: Difficulty, max_days: u64) -> Option<(u64, u32)> {
    let mut s = Sim::new(seed, SIZE, SIZE);
    s.step(&[Command::SetDifficulty { level: difficulty }]);
    for _ in 0..max_days * DAY {
        feed(&mut s);
        s.step(&[]);
        if let Some(e) = s.events().iter().find(|e| e.kind == EventKind::Raid) {
            return Some((s.tick(), e.arg));
        }
    }
    None
}

/// En difficile, la première bande fait la même taille qu'en normal — deux
/// têtes — et n'arrive pas avant le délai de grâce. Sans ça, trois pillards
/// armés tombent au jour 3 sur trois colons qui n'ont pas encore de poste de
/// fabrication : la campagne mesurée éteignait 25 colonies sur 30 avant le
/// jour 10 (§4). Ce n'est pas un effet de bord du réglage des points, c'est
/// une règle : `storyteller::FIRST_RAID_POINTS`.
#[test]
fn le_premier_raid_en_difficile_reste_a_deux_tetes() {
    const SEEDS: u64 = 12;
    /// Le délai de grâce, le même à toutes les difficultés.
    const MIN_DAYS: u64 = GRACE_DAYS as u64;

    let mut sizes = Vec::new();
    let mut earliest = u64::MAX;
    for seed in 1..=SEEDS {
        // Une carte sur dix environ naît sur un morceau de terre isolé, où
        // `find_entry_tile` ne trouve pas d'entrée : aucune bande n'y arrive
        // jamais (le rapport le note pour la graine 7 de la campagne). Ces
        // cartes-là ne disent rien sur la taille des bandes.
        let Some((tick, size)) = first_natural_raid(seed, Difficulty::Hard, 8) else {
            continue;
        };
        earliest = earliest.min(tick);
        sizes.push(size);
        assert!(
            size <= 2,
            "graine {seed} : {size} pillards au premier raid en difficile, au jour {}",
            tick / DAY
        );
    }
    assert!(
        sizes.len() as u64 >= SEEDS - 2,
        "seulement {} graines sur {SEEDS} ont reçu une bande : la mesure ne dit plus rien",
        sizes.len()
    );
    assert!(
        earliest >= MIN_DAYS * DAY,
        "premier raid en difficile au tick {earliest} (jour {}), avant le jour {MIN_DAYS}",
        earliest / DAY
    );
    // Le témoin : en normal, la même bande fait deux têtes elle aussi. Si ce
    // n'était plus vrai, l'égalité ci-dessus ne dirait plus rien.
    let normal = first_natural_raid(1, Difficulty::Normal, 8).expect("aucun raid en normal");
    assert_eq!(normal.1, 2, "témoin normal : {} têtes", normal.1);
    assert_eq!(
        mean_hundredths(&sizes),
        200,
        "bandes difficiles : {sizes:?}"
    );
}

/// Le plafond ne vaut que pour la **première** bande : la deuxième reprend la
/// menace entière. Sans ce témoin, on aurait pu plafonner tous les raids et
/// faire passer les tests de survie sans qu'il reste une difficulté.
#[test]
fn la_deuxieme_bande_reprend_la_menace_entiere() {
    const SEEDS: u64 = 8;
    /// De quoi valoir plus que la bande de référence : 3 300 de richesse
    /// rendent 40 points de menace (8 au tarif ordinaire, 32 au tarif fort
    /// au-delà de `WEALTH_RICH_FROM`).
    const WOOD: u32 = 3_000;

    let mut second = Vec::new();
    for seed in 1..=SEEDS {
        let mut s = aged_colony(seed, Difficulty::Hard, 0, WOOD);
        // La richesse n'est relue qu'une fois par `WEALTH_CACHE_TICKS` : un
        // jour d'avance rapide la met à jour sans jouer les ticks.
        s.fast_forward(TICKS_PER_DAY);
        assert!(s.spawn_raid() > 0, "graine {seed} : pas de première bande");
        assert_eq!(raiders(&s), 2, "graine {seed} : première bande plafonnée");
        wipe_raiders(&mut s);
        s.spawn_raid();
        second.push(raiders(&s));
    }
    assert!(
        mean_hundredths(&second) > 200,
        "deuxième bande : {second:?} — le plafond de la première déborde sur la suite"
    );
}

/// Dix jours de difficile, colonie nourrie mais sans ordres : la moitié au
/// moins des colonies doit encore tenir debout. C'est le plancher que la
/// campagne du joueur scripté doit ensuite confirmer (§4) — ici, aucun ordre
/// n'est donné, donc aucune arme et aucun mur : c'est la pression des raids
/// toute seule, sans rien pour l'amortir.
///
/// **Mesuré** : 5 colonies sur 12 avant réglage, **10 sur 12** après.
#[test]
fn difficile_laisse_passer_le_dixieme_jour() {
    const SEEDS: u64 = 12;
    const DAYS: u64 = 10;

    let mut alive = 0u32;
    let mut survivors = Vec::new();
    for seed in 1..=SEEDS {
        let mut s = Sim::new(seed, SIZE, SIZE);
        s.step(&[Command::SetDifficulty {
            level: Difficulty::Hard,
        }]);
        for _ in 0..DAYS * DAY {
            if colonists(&s) == 0 {
                break;
            }
            feed(&mut s);
            s.step(&[]);
        }
        let n = colonists(&s);
        survivors.push(n);
        if n > 0 {
            alive += 1;
        }
    }
    assert!(
        alive * 2 >= SEEDS as u32,
        "{alive} colonies sur {SEEDS} passent le jour {DAYS} en difficile \
         (il en faut la moitié) — colons restants : {survivors:?}"
    );
}
