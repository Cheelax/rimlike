//! Le métal, du minerai à l'épée : veines dans la roche, forge verrouillée par
//! la métallurgie, fonte des lingots, épée au poste de fabrication, et ce
//! qu'elle vaut vraiment face à un épieu.
//!
//! Style et conventions : voir `gameplay.rs`, dont ce fichier reprend la
//! clairière et le `run_until`. Le duel de `sword_beats_spear_but_is_not_a_win_button`
//! suit la règle « on mesure avant de régler » (`AGENTS.md`) : il compare deux
//! séries de trente duels, il ne décrète pas un chiffre.

use sim::craft::{METAL_PER_SWORD, ORE_PER_INGOT};
use sim::items::SWORD_MELEE_PERCENT;
use sim::jobs::{ORE_YIELD_MIN, ORE_YIELD_SPAN};
use sim::pawn::NEED_MAX;
use sim::research::TECH_COUNT;
use sim::storyteller::SWORD_THREAT_POINTS;
use sim::testmap::map_from;
use sim::{
    BuildKind, Command, Designation, EventKind, Faction, Feature, ItemKind, Material, RaidKind,
    Sim, TICKS_PER_DAY, Tech, Zone,
};

const DAY: u64 = TICKS_PER_DAY as u64;

fn run_until(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        s.step(&[]);
    }
    pred(s)
}

/// Clairière plate : rien à couper, rien à cueillir. Ce qui s'y passe vient
/// des piles qu'on y pose et des ateliers qu'on y plante.
fn clearing() -> Sim {
    Sim::from_map(
        1,
        map_from(&[
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
        ]),
    )
}

/// De quoi tenir plusieurs jours sans que la faim vienne interrompre l'atelier.
fn feed(s: &mut Sim) {
    s.spawn_item(ItemKind::Berries, 200, 1, 6);
}

// ----------------------------------------------------------------------
// Le contrat des valeurs
// ----------------------------------------------------------------------

/// Les numéros de `ItemKind` et de `Tech` sont un contrat avec le client
/// (`AGENTS.md`, tableau « Contrats entre Rust et TypeScript ») : un décalage
/// ici casse silencieusement les tampons `stored_totals`, `craft_targets`,
/// `buy_prices` et `research_state`.
#[test]
fn the_new_kinds_and_techs_keep_their_numbers() {
    assert_eq!(ItemKind::Ore as u8, 16);
    assert_eq!(ItemKind::Metal as u8, 17);
    assert_eq!(ItemKind::Sword as u8, 18);
    assert_eq!(ItemKind::COUNT, 19);
    for k in 0..ItemKind::COUNT as u8 {
        assert_eq!(ItemKind::from_u8(k) as u8, k, "aller-retour du genre {k}");
    }

    assert_eq!(Tech::Metallurgy as u8, 5);
    assert_eq!(TECH_COUNT, 6);
    assert_eq!(Tech::ALL.len(), TECH_COUNT);
    assert_eq!(Tech::from_u8(5), Some(Tech::Metallurgy));
    assert_eq!(Tech::from_u8(6), None, "aucune septième technologie");
    assert_eq!(Tech::Metallurgy.cost(), 3_500);

    assert_eq!(Feature::OreRock as u8, 19);
    assert_eq!(Feature::Forge as u8, 20);
    assert_eq!(BuildKind::Forge as u8, 9);
    assert_eq!(Feature::from_u8(19), Feature::OreRock);
    assert_eq!(Feature::from_u8(20), Feature::Forge);
    assert_eq!(BuildKind::from_u8(9), BuildKind::Forge);

    // L'épée frappe plus fort que l'épieu, sans atteindre le double d'un
    // poing nu et demi de plus (voir la mesure du duel).
    assert!(SWORD_MELEE_PERCENT > ItemKind::Spear.melee_percent());
    assert!(ItemKind::Sword.weapon_rank() > ItemKind::Bow.weapon_rank());
    assert!(ItemKind::Sword.is_weapon());
    assert!(!ItemKind::Metal.is_weapon() && !ItemKind::Ore.is_weapon());
    // Rien de tout cela ne se mange ni ne se gâte.
    for kind in [ItemKind::Ore, ItemKind::Metal, ItemKind::Sword] {
        assert!(!kind.is_food(), "{kind:?} comestible");
        assert_eq!(kind.shelf_life(), None, "{kind:?} périssable");
    }
}

// ----------------------------------------------------------------------
// Les veines
// ----------------------------------------------------------------------

/// La génération sème des rochers veinés parmi les rochers, à peu près un sur
/// `ORE_IN_ROCKS`. La fourchette tolérée est large (un rocher sur seize à un
/// sur quatre) : ce qui est vérifié, c'est qu'il y en a **partout** et qu'ils
/// restent minoritaires, pas un ratio au pour-cent près.
///
/// Toutes les cartes n'ont pas de montagne : c'est l'élévation qui décide, et
/// une graine peut donner une plaine sans un rocher — donc sans pierre et sans
/// minerai. **Mesuré sur vingt graines** : 9 cartes rocheuses sur 20 en 48×48,
/// 11 en 64×64, 17 en 128×128, la taille que joue le client. Le semis de
/// veines n'y change rien : c'est une propriété de `Map::generate` antérieure
/// au métal (elle privait déjà ces colonies de pierre), signalée, pas traitée
/// ici.
///
/// Le ratio, lui, ne se juge **par carte** qu'à partir de `RATIO_SAMPLE`
/// rochers — en dessous, un caillou de plus ou de moins fait basculer
/// n'importe quelle borne (graine 9 en 64×64 : deux veines sur six rochers) —
/// et toutes graines confondues sur le total.
#[test]
fn ore_rocks_exist_and_yield_ore() {
    const SEEDS: u64 = 10;
    /// Rochers en dessous desquels le ratio d'une carte ne veut rien dire.
    const RATIO_SAMPLE: u32 = 40;

    /// Rochers et rochers veinés d'une carte.
    fn count(size: u32, seed: u64) -> (u32, u32) {
        let s = Sim::new(seed, size, size);
        let (mut plain, mut veined) = (0u32, 0u32);
        for y in 0..s.map().height() {
            for x in 0..s.map().width() {
                match s.map().feature(x, y) {
                    Feature::Rock => plain += 1,
                    Feature::OreRock => veined += 1,
                    _ => {}
                }
            }
        }
        (plain + veined, veined)
    }

    let (mut all_rocks, mut all_veins, mut rocky_maps) = (0u32, 0u32, 0u32);
    for seed in 1..=SEEDS {
        let (rocks, veined) = count(64, seed);
        if rocks == 0 {
            continue;
        }
        rocky_maps += 1;
        all_rocks += rocks;
        all_veins += veined;
        if rocks < RATIO_SAMPLE {
            continue;
        }
        assert!(
            veined > 0,
            "graine {seed} : aucune veine sur {rocks} rochers"
        );
        assert!(
            veined * 16 >= rocks,
            "graine {seed} : {veined} veines sur {rocks} rochers, moins d'une sur seize"
        );
        assert!(
            veined * 4 <= rocks,
            "graine {seed} : {veined} veines sur {rocks} rochers, plus d'une sur quatre"
        );
    }
    assert!(
        rocky_maps >= 3,
        "seulement {rocky_maps}/{SEEDS} cartes rocheuses en 64×64"
    );
    assert!(
        all_veins * 16 >= all_rocks && all_veins * 4 <= all_rocks,
        "{all_veins} veines sur {all_rocks} rochers, toutes graines confondues"
    );

    // À la taille que joue le client (128×128), le minerai doit être la règle
    // et non l'exception : au moins sept colonies sur dix ont une veine à miner.
    let veined_maps = (1..=SEEDS).filter(|&seed| count(128, seed).1 > 0).count() as u64;
    assert!(
        veined_maps * 10 >= SEEDS * 7,
        "seulement {veined_maps}/{SEEDS} cartes 128×128 ont une veine"
    );

    // Miné, un rocher veiné rend du minerai — deux ou trois unités — là où un
    // rocher ordinaire rend quinze pierres.
    let mut s = Sim::from_map(
        1,
        map_from(&[
            "............",
            "............",
            "..%.........",
            "............",
            "............",
            "............",
            "............",
            "............",
        ]),
    );
    feed(&mut s);
    assert_eq!(s.map().feature(2, 2), Feature::OreRock);
    s.step(&[Command::Designate {
        kind: Designation::Mine,
        x0: 2,
        y0: 2,
        x1: 2,
        y1: 2,
    }]);
    assert_eq!(
        s.map().designation(2, 2),
        Designation::Mine,
        "une veine se désigne comme un rocher"
    );
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.colony_total(ItemKind::Ore) > 0),
        "aucun minerai extrait"
    );
    let ore = s.colony_total(ItemKind::Ore);
    assert!(
        (ORE_YIELD_MIN..ORE_YIELD_MIN + ORE_YIELD_SPAN).contains(&ore),
        "{ore} minerais pour une veine"
    );
    assert_eq!(
        s.map().feature(2, 2),
        Feature::None,
        "la veine tient encore"
    );
    assert_eq!(
        s.colony_total(ItemKind::Stone),
        0,
        "une veine rend du minerai"
    );
}

// ----------------------------------------------------------------------
// La forge
// ----------------------------------------------------------------------

/// La première construction verrouillée derrière une technologie : sans
/// métallurgie, l'ordre est ignoré — pas de plan, pas d'événement, rien.
#[test]
fn forge_requires_metallurgy() {
    let mut s = clearing();
    feed(&mut s);
    s.spawn_item(ItemKind::Stone, 60, 5, 6);
    let forge = Command::Build {
        kind: BuildKind::Forge,
        // Matériau volontairement faux : la forge impose la pierre.
        material: Material::Wood,
        x0: 9,
        y0: 2,
        x1: 9,
        y1: 2,
    };

    s.step(&[forge.clone()]);
    assert!(
        s.blueprints().is_empty(),
        "forge planifiée sans métallurgie : {:?}",
        s.blueprints()
    );
    assert!(
        !s.events().iter().any(|e| e.kind == EventKind::ResearchDone),
        "un refus silencieux n'annonce rien"
    );

    // Les autres constructions, elles, n'ont jamais rien demandé.
    s.step(&[Command::Build {
        kind: BuildKind::CraftingSpot,
        material: Material::Wood,
        x0: 8,
        y0: 6,
        x1: 8,
        y1: 6,
    }]);
    assert_eq!(s.blueprints().len(), 1, "le poste, lui, passe");
    s.step(&[Command::CancelBuild {
        x0: 8,
        y0: 6,
        x1: 8,
        y1: 6,
    }]);

    // La technologie acquise, le même ordre passe.
    s.research_mut().complete(Tech::Metallurgy);
    s.step(&[forge]);
    assert_eq!(s.blueprints().len(), 1, "forge toujours refusée");
    assert_eq!(
        s.blueprints()[0].material,
        Material::Stone,
        "la forge se bâtit en pierre, quoi qu'on demande"
    );
    assert_eq!(s.blueprints()[0].needed, BuildKind::Forge.cost());
    assert!(
        run_until(&mut s, 3 * DAY, |s| s.map().forge_count() == 1),
        "forge jamais achevée : {:?}",
        s.blueprints()
    );
    assert_eq!(s.map().feature(9, 2), Feature::Forge);
    assert!(
        !s.map().passable(9, 2),
        "on ne traverse pas une forge, comme un poste de fabrication"
    );
}

// ----------------------------------------------------------------------
// La fonte
// ----------------------------------------------------------------------

/// Un objectif qu'on **ne peut pas** tenir — des lingots sans une once de
/// minerai — est sauté, pas attendu : la colonie taille ce qu'elle peut. C'est
/// aussi ce qui évite qu'un colon désœuvré balaie les 4 096 cases de la carte à
/// chaque tick pour y chercher une forge qui ne lui servira à rien (voir
/// `Sim::wanted_craft`).
#[test]
fn an_impossible_target_does_not_block_the_workshop() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    s.map_mut().set_feature(9, 5, Feature::Forge);
    // Du bois, et pas un gramme de minerai.
    s.spawn_item(ItemKind::Wood, 20, 4, 5);
    s.step(&[
        Command::SetCraftTarget {
            kind: ItemKind::Metal,
            target: 5,
        },
        Command::SetCraftTarget {
            kind: ItemKind::Club,
            target: 1,
        },
    ]);
    assert!(
        run_until(&mut s, DAY, |s| s.colony_total(ItemKind::Club) >= 1),
        "un objectif de lingots intenable a bloqué la taille"
    );
    assert_eq!(s.colony_total(ItemKind::Metal), 0, "fonte sans minerai");
}

/// Trois minerais font un lingot, à la forge et nulle part ailleurs. Un
/// objectif de lingots posé sans forge ne bloque pas le reste de l'atelier :
/// la colonie continue de tailler.
#[test]
fn smelting_turns_ore_into_metal() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    s.spawn_item(ItemKind::Ore, 12, 5, 5);
    s.spawn_item(ItemKind::Wood, 20, 4, 5);

    // Sans forge : rien ne fond, et le gourdin passe devant la file.
    s.step(&[
        Command::SetCraftTarget {
            kind: ItemKind::Metal,
            target: 2,
        },
        Command::SetCraftTarget {
            kind: ItemKind::Club,
            target: 1,
        },
    ]);
    assert!(
        run_until(&mut s, DAY, |s| s.colony_total(ItemKind::Club) >= 1),
        "un objectif de lingots sans forge a bloqué la taille"
    );
    assert_eq!(
        s.colony_total(ItemKind::Metal),
        0,
        "du métal fondu sans forge"
    );
    assert_eq!(
        s.colony_total(ItemKind::Ore),
        12,
        "minerai entamé sans forge"
    );

    // La forge posée, la fonte démarre d'elle-même.
    s.map_mut().set_feature(9, 5, Feature::Forge);
    assert_eq!(s.map().forge_count(), 1);
    let mut smelted = false;
    let done = run_until(&mut s, 3 * DAY, |s| s.colony_total(ItemKind::Metal) >= 2);
    assert!(
        done,
        "aucun lingot fondu : {} minerais restants",
        s.colony_total(ItemKind::Ore)
    );
    assert_eq!(
        s.colony_total(ItemKind::Ore),
        12 - 2 * ORE_PER_INGOT,
        "le lingot coûte trois minerais, pas plus"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::ItemCrafted && e.arg == ItemKind::Metal as u32),
        "aucun événement de fabrication : {:?}",
        s.events()
    );

    // L'objectif atteint, on s'arrête, minerai plein les bras.
    for _ in 0..DAY {
        s.step(&[]);
        smelted |= s.pawns().iter().any(|p| p.job.code() == 30);
        assert_eq!(
            s.colony_total(ItemKind::Metal),
            2,
            "fonte en trop au tick {}",
            s.tick()
        );
    }
    assert!(
        !smelted,
        "un colon fond encore alors que l'objectif est atteint"
    );
}

/// Le code de job de la fonte est distinct de celui de la taille : le client
/// écrit « fond le métal », pas « fabrique » (contrat `Job::code`).
#[test]
fn smelting_has_its_own_job_code() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(9, 5, Feature::Forge);
    s.spawn_item(ItemKind::Ore, 6, 5, 5);
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Metal,
        target: 1,
    }]);
    assert!(
        run_until(&mut s, 2 * DAY, |s| s
            .pawns()
            .iter()
            .any(|p| p.job.code() == 30)),
        "personne ne fond : {:?}",
        s.pawns().iter().map(|p| p.job.code()).collect::<Vec<_>>()
    );
}

// ----------------------------------------------------------------------
// L'épée
// ----------------------------------------------------------------------

/// Quatre lingots font une épée, au poste de fabrication (pas à la forge), et
/// un colon la préfère à tout ce qu'il connaît.
#[test]
fn swords_are_crafted_and_equipped() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    // L'entrepôt à côté du poste : l'épée fabriquée y sera rangée, et c'est là
    // qu'un colon vient s'armer.
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 6,
        y0: 2,
        x1: 7,
        y1: 3,
    }]);
    s.spawn_item(ItemKind::Metal, 6, 5, 5);

    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Sword,
        target: 1,
    }]);
    assert!(
        run_until(&mut s, 3 * DAY, |s| s.colony_total(ItemKind::Sword) >= 1),
        "aucune épée forgée, {} lingots en stock",
        s.colony_total(ItemKind::Metal)
    );
    assert_eq!(
        s.colony_total(ItemKind::Metal),
        6 - METAL_PER_SWORD,
        "l'épée coûte quatre lingots"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::WeaponCrafted && e.arg == ItemKind::Sword as u32),
        "l'épée n'a pas été annoncée comme une arme : {:?}",
        s.events()
    );

    assert!(
        run_until(&mut s, 2 * DAY, |s| s
            .pawns()
            .iter()
            .any(|p| p.weapon == Some(ItemKind::Sword))),
        "personne ne s'est armé de l'épée : {:?}",
        s.pawns().iter().map(|p| p.weapon).collect::<Vec<_>>()
    );
    // Une seule épée pour toute la colonie : les autres restent comme ils sont.
    assert_eq!(
        s.pawns()
            .iter()
            .filter(|p| p.weapon == Some(ItemKind::Sword))
            .count(),
        1
    );
}

// ----------------------------------------------------------------------
// Le duel : ce que l'épée vaut vraiment
// ----------------------------------------------------------------------

/// Niveau de mêlée imposé aux duellistes : seule l'arme doit changer.
const DUEL_MELEE_LEVEL: u8 = 6;
/// Un duel qui n'a pas tranché au bout de ce temps est déclaré nul.
const DUEL_TICKS: u64 = 3_000;
const DUELS: u32 = 30;
/// Pillards lâchés sur le duelliste. **Mesuré** : à un contre un, le colon
/// gagne les trente duels avec l'épieu comme avec l'épée (un pillard blessé
/// décroche) et la comparaison ne mesure plus rien ; à trois contre un, il les
/// perd toutes les trente. À deux contre un, l'issue est disputée et l'arme se
/// voit : 21 victoires sur 30 à l'épée contre 10 à l'épieu.
const DUEL_FOES: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Duel {
    ColonistWins,
    ColonistLoses,
    Draw,
}

/// Un colon armé de `weapon` contre `DUEL_FOES` pillards à l'épieu, à armes
/// égales pour tout le reste : même niveau de mêlée, aucun trait de caractère,
/// ventre plein. Il l'emporte quand plus un pillard ne tient debout sur la
/// carte — tués, à terre ou partis.
fn duel(seed: u64, weapon: ItemKind) -> Duel {
    // La graine décide des tirages de combat ; la carte reste la même pour que
    // les distances de départ ne varient pas d'un duel à l'autre.
    let mut s = Sim::from_map(seed, clearing().map().clone());
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    for &id in &ids[1..] {
        s.pawn_mut(id).expect("colon vivant").gone = true;
    }
    s.step(&[]);
    let colonist = ids[0];
    {
        let p = s.pawn_mut(colonist).expect("le colon a survécu au ménage");
        p.weapon = Some(weapon);
        p.melee.level = DUEL_MELEE_LEVEL;
        p.melee.xp = 0;
        p.traits = [None, None];
        p.hunger = NEED_MAX;
        p.rest = NEED_MAX;
    }
    let (cx, cy) = s
        .pawns()
        .iter()
        .find(|p| p.id == colonist)
        .expect("le colon est là")
        .tile();
    // Autour de lui, dans un ordre fixe : le duel doit être le même à l'arme
    // près.
    let spots = [(1i32, 0i32), (-1, 0), (0, 1), (0, -1)];
    for &(dx, dy) in spots.iter().take(DUEL_FOES as usize) {
        let (rx, ry) = (cx as i32 + dx, cy as i32 + dy);
        assert!(s.map().in_bounds(rx, ry), "arène trop petite");
        let raider = s.spawn_pawn(rx as u32, ry as u32, Faction::Raider);
        let p = s.pawn_mut(raider).expect("le pillard vient d'entrer");
        p.weapon = Some(ItemKind::Spear);
        p.melee.level = DUEL_MELEE_LEVEL;
        p.hunger = NEED_MAX;
        p.rest = NEED_MAX;
    }
    for _ in 0..DUEL_TICKS {
        // Le colon est regardé le premier : à coups simultanés, le duel est
        // compté contre lui. La règle est la même pour les deux armes, elle ne
        // fausse donc pas la comparaison.
        match s.pawns().iter().find(|p| p.id == colonist) {
            None => return Duel::ColonistLoses,
            Some(p) if !p.is_alive() || p.is_downed() => return Duel::ColonistLoses,
            _ => {}
        }
        let standing = s
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Raider && p.is_alive() && !p.is_downed() && !p.gone)
            .count();
        if standing == 0 {
            return Duel::ColonistWins;
        }
        s.step(&[]);
    }
    Duel::Draw
}

fn wins(weapon: ItemKind) -> u32 {
    (1..=u64::from(DUELS))
        .filter(|&seed| duel(seed, weapon) == Duel::ColonistWins)
        .count() as u32
}

/// **Mesure**, pas décret : trente duels par arme, mêmes graines, mêmes bras.
/// L'épée doit faire pencher la balance sans la renverser — un colon qui gagne
/// à tous les coups ferait de la métallurgie un bouton « gagner ».
///
/// Relevé au réglage (`items::SWORD_MELEE_PERCENT` à 200) : **21 victoires sur
/// 30 à l'épée, 10 sur 30 à l'épieu**. Deux fois mieux, et neuf duels perdus
/// quand même.
#[test]
fn sword_beats_spear_but_is_not_a_win_button() {
    let sword = wins(ItemKind::Sword);
    let spear = wins(ItemKind::Spear);
    assert!(
        sword > spear,
        "l'épée ({sword}/{DUELS}) ne fait pas mieux que l'épieu ({spear}/{DUELS})"
    );
    assert!(
        sword < DUELS,
        "l'épée gagne les {DUELS} duels : ce n'est plus une arme, c'est un interrupteur"
    );
    assert!(
        spear > 0,
        "l'épieu ne gagne jamais : la comparaison ne mesure plus rien"
    );
}

// ----------------------------------------------------------------------
// Les pillards
// ----------------------------------------------------------------------

/// L'épée n'est pas une arme de maraudeur : il faut une bande sérieuse
/// (`SWORD_THREAT_POINTS`) pour qu'un pillard en porte une, et le butin tombe
/// au sol quand il meurt.
#[test]
fn raiders_can_bring_swords_at_high_threat() {
    const SIZE: u32 = 48;
    // Une colonie sans le sou, au tick 0 : la bande n'a pas les moyens.
    for seed in 1..=10u64 {
        let mut s = Sim::new(seed, SIZE, SIZE);
        assert!(
            s.threat_points() < SWORD_THREAT_POINTS,
            "graine {seed} : {} points au tick 0",
            s.threat_points()
        );
        s.trigger_raid_of(RaidKind::Rush);
        assert!(
            !s.pawns()
                .iter()
                .any(|p| p.faction == Faction::Raider && p.weapon == Some(ItemKind::Sword)),
            "graine {seed} : une épée dans la bande du premier jour"
        );
    }

    // Une colonie prospère et installée : les épées sortent.
    let mut seen = 0;
    for seed in 1..=10u64 {
        let mut s = Sim::new(seed, SIZE, SIZE);
        let (cx, cy) = s
            .map()
            .nearest_passable(SIZE / 2, SIZE / 2)
            .expect("carte sans centre franchissable");
        // 6 000 de bois : la richesse d'une colonie de fin de campagne, comptée
        // deux fois au-delà de `WEALTH_RICH_FROM`.
        s.spawn_item(ItemKind::Wood, 6_000, cx, cy);
        s.fast_forward(TICKS_PER_DAY * 30);
        assert!(
            s.threat_points() >= SWORD_THREAT_POINTS,
            "graine {seed} : {} points seulement",
            s.threat_points()
        );
        s.trigger_raid_of(RaidKind::Rush);
        if s.pawns()
            .iter()
            .any(|p| p.faction == Faction::Raider && p.weapon == Some(ItemKind::Sword))
        {
            seen += 1;
        }
    }
    assert!(
        seen > 0,
        "aucune épée sur dix bandes riches : le catalogue ne s'ouvre jamais"
    );
}

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

/// Tout ce que le métal ajoute est de l'état : les veines, la forge et son
/// compteur, les piles de minerai et de lingots, les objectifs et la
/// technologie. Un aller-retour par le snapshot doit tout rendre à l'identique.
#[test]
fn snapshot_keeps_ore_and_forge() {
    let mut s = Sim::from_map(
        7,
        map_from(&[
            "............",
            "..%.........",
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
        ]),
    );
    feed(&mut s);
    s.research_mut().complete(Tech::Metallurgy);
    s.map_mut().set_feature(9, 5, Feature::Forge);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    s.spawn_item(ItemKind::Ore, 9, 5, 5);
    s.spawn_item(ItemKind::Metal, 2, 5, 6);
    s.step(&[
        Command::SetCraftTarget {
            kind: ItemKind::Metal,
            target: 3,
        },
        Command::SetCraftTarget {
            kind: ItemKind::Sword,
            target: 1,
        },
    ]);
    for _ in 0..600 {
        s.step(&[]);
    }

    let bytes = s.snapshot();
    let back = Sim::restore(&bytes).expect("snapshot relisible");
    assert_eq!(back, s, "l'état ne survit pas à l'aller-retour");
    assert_eq!(back.state_hash(), s.state_hash());
    assert_eq!(back.map().forge_count(), 1);
    assert_eq!(back.map().feature(9, 5), Feature::Forge);
    assert_eq!(back.map().feature(2, 1), Feature::OreRock);
    assert!(back.research().is_done(Tech::Metallurgy));
    assert_eq!(back.craft_targets()[ItemKind::Metal as usize], 3);
    assert_eq!(back.craft_targets()[ItemKind::Sword as usize], 1);
    assert_eq!(back.craft_targets().len(), ItemKind::COUNT);

    // Et la partie repart pareil des deux côtés.
    let mut a = s;
    let mut b = back;
    for _ in 0..600 {
        a.step(&[]);
        b.step(&[]);
    }
    assert_eq!(a.state_hash(), b.state_hash(), "divergence après reprise");
}

/// Une veine ne se sème pas au hasard du moment : même graine, même carte.
/// Deux cartes bâties séparément portent exactement les mêmes veines — c'est
/// ce qui permet à deux clients d'une même salle de miner la même montagne.
#[test]
fn ore_veins_are_deterministic() {
    for seed in 1..=4u64 {
        let a = Sim::new(seed, 48, 48);
        let b = Sim::new(seed, 48, 48);
        assert_eq!(a.map().features(), b.map().features(), "graine {seed}");
        assert_eq!(a.state_hash(), b.state_hash(), "graine {seed}");
    }
}
