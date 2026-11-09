//! Régressions de la défense autonome : une enceinte avec une vraie porte,
//! des pillards qui marchent, et des cibles qui quittent le seuil.
use sim::combat::Stance;
use sim::fixed::FX_HALF;
use sim::map::{Feature, Zone};
use sim::pawn::{Job, NEED_MAX};
use sim::testmap::map_from;
use sim::{Command, Faction, ItemKind, Sim};

const DOOR: (u32, u32) = (12, 12);

fn colony() -> Sim {
    colony_with_size(25)
}

fn colony_with_size(size: usize) -> Sim {
    let row = ".".repeat(size);
    let mut s = Sim::from_map(17, map_from(&vec![row.as_str(); size]));
    let ids: Vec<_> = s.pawns().iter().map(|p| p.id).collect();
    for id in ids {
        s.pawn_mut(id).unwrap().gone = true;
    }
    s.step(&[]);
    for n in 7..=17 {
        s.map_mut().set_feature(n, 2, Feature::WallWood);
        s.map_mut().set_feature(n, 12, Feature::WallWood);
    }
    for n in 2..=12 {
        s.map_mut().set_feature(7, n, Feature::WallWood);
        s.map_mut().set_feature(17, n, Feature::WallWood);
    }
    s.map_mut().set_feature(DOOR.0, DOOR.1, Feature::DoorWood);
    s.map_mut().refresh_indoor();
    s
}

fn pawn(s: &mut Sim, at: (u32, u32), faction: Faction, weapon: Option<ItemKind>) -> u32 {
    let id = s.spawn_pawn(at.0, at.1, faction);
    let p = s.pawn_mut(id).unwrap();
    p.traits = [None, None];
    p.hunger = NEED_MAX;
    p.rest = NEED_MAX;
    p.weapon = weapon;
    id
}

fn overwhelming_raid(s: &mut Sim) {
    let until = s.tick() + 600;
    for x in 9..15 {
        let id = pawn(s, (x, 21), Faction::Raider, Some(ItemKind::Spear));
        s.pawn_mut(id).unwrap().job = Job::Wait { until };
    }
}

#[test]
fn les_colons_loin_de_leur_enceinte_la_retrouvent_pendant_le_preavis() {
    let mut s = colony_with_size(80);
    let ids = [
        pawn(&mut s, (65, 65), Faction::Colony, None),
        pawn(&mut s, (66, 66), Faction::Colony, None),
    ];
    for x in 1..7 {
        let id = pawn(&mut s, (x, 77), Faction::Raider, Some(ItemKind::Spear));
        s.pawn_mut(id).unwrap().job = Job::Wait { until: 10_000 };
    }
    assert_eq!(s.raid_stance(), Stance::Watch);
    let sheltered = (0..4_000).any(|_| {
        s.step(&[]);
        ids.iter().all(|id| {
            s.pawns()
                .iter()
                .any(|p| p.id == *id && s.map().room(p.tile().0, p.tile().1) != 0)
        })
    });
    assert!(
        sheltered,
        "le barycentre loin des murs ne doit pas faire oublier l'abri"
    );
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.is_colonist())
            .all(|p| p.injuries.is_empty())
    );
    let mut restored = Sim::restore(&s.snapshot()).unwrap();
    for _ in 0..120 {
        s.step(&[]);
        restored.step(&[]);
    }
    assert_eq!(s.state_hash(), restored.state_hash());
}

#[test]
fn la_veille_ferme_la_porte_aux_pillards_qui_marchent() {
    let mut s = colony();
    let ids = [
        pawn(&mut s, (11, 7), Faction::Colony, None),
        pawn(&mut s, (13, 7), Faction::Colony, None),
    ];
    overwhelming_raid(&mut s);
    assert_eq!(s.raid_stance(), Stance::Watch);
    for _ in 0..3_000 {
        s.step(&[]);
        assert!(
            s.pawns()
                .iter()
                .filter(|p| p.faction == Faction::Raider)
                .all(|p| s.map().room(p.tile().0, p.tile().1) == 0),
            "un pillard est entré malgré la veille au tick {}",
            s.tick()
        );
    }
    for id in ids {
        assert!(
            s.pawns()
                .iter()
                .any(|p| p.id == id && p.is_alive() && p.injuries.is_empty()),
            "le colon {id} a été blessé derrière sa porte fermée"
        );
    }
    assert!(
        !s.pawns()
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive()),
        "la bande doit repartir faute de cible atteignable"
    );
}

#[test]
fn la_defense_automatique_ne_poursuit_pas_une_cible_sortie_du_seuil() {
    let mut s = colony();
    for x in 10..13 {
        pawn(&mut s, (x, 10), Faction::Colony, Some(ItemKind::Spear));
    }
    let target = pawn(&mut s, DOOR, Faction::Raider, None);
    s.pawn_mut(target).unwrap().job = Job::Wait { until: u64::MAX };
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Hold);
    assert!(
        s.pawns()
            .iter()
            .any(|p| p.is_colonist() && p.job.code() == 12)
    );
    // La cible se retire après la prise de décision : le prochain tick doit
    // réévaluer la poursuite, pas seulement le choix initial de l'ennemi.
    let p = s.pawn_mut(target).unwrap();
    p.x = 12 * 256 + FX_HALF;
    p.y = 17 * 256 + FX_HALF;
    p.path.clear();
    p.job = Job::Wait { until: u64::MAX };
    for _ in 0..600 {
        s.step(&[]);
        assert!(
            s.pawns()
                .iter()
                .filter(|p| p.is_colonist())
                .all(|p| s.map().room(p.tile().0, p.tile().1) != 0),
            "une poursuite automatique a fait sortir un colon au tick {}",
            s.tick()
        );
    }
}

#[test]
fn la_veille_garde_les_colons_affames_au_stock_interieur() {
    let mut s = colony();
    let hungry = pawn(&mut s, (12, 11), Faction::Colony, None);
    pawn(&mut s, (13, 7), Faction::Colony, None);
    // Le repas dehors est plus proche et de meilleure qualité : sans filtre,
    // le colon quitte sa protection pour le prendre.
    s.spawn_item(ItemKind::Meal, 10, 12, 14);
    s.spawn_item(ItemKind::Berries, 50, 10, 4);
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 10,
        y0: 4,
        x1: 10,
        y1: 4,
    }]);
    s.pawn_mut(hungry).unwrap().hunger = 90_000;
    overwhelming_raid(&mut s);
    for _ in 0..900 {
        s.step(&[]);
        let p = s
            .pawns()
            .iter()
            .find(|p| p.id == hungry)
            .expect("le colon doit vivre");
        assert_ne!(
            s.map().room(p.tile().0, p.tile().1),
            0,
            "le colon est sorti chercher à manger pendant la veille"
        );
    }
    assert!(
        s.pawns().iter().find(|p| p.id == hungry).unwrap().hunger > 100_000,
        "la nourriture intérieure doit rester accessible"
    );
}

#[test]
fn un_ordre_manuel_remplace_une_defense_sans_garder_son_confinement() {
    let mut s = colony();
    let hero = pawn(&mut s, (12, 10), Faction::Colony, Some(ItemKind::Spear));
    for x in 10..12 {
        pawn(&mut s, (x, 10), Faction::Colony, Some(ItemKind::Spear));
    }
    let target = pawn(&mut s, DOOR, Faction::Raider, None);
    s.pawn_mut(target).unwrap().job = Job::Wait { until: u64::MAX };
    s.step(&[]);
    assert!(matches!(s.pawn_mut(hero).unwrap().job, Job::Defend { .. }));
    s.step(&[Command::MoveTo {
        pawn: hero,
        x: 12,
        y: 17,
    }]);
    assert!(matches!(
        s.pawn_mut(hero).unwrap().job,
        Job::Move { manual: true }
    ));
    let reached = (0..600).any(|_| {
        s.step(&[]);
        s.pawn_mut(hero).is_some_and(|p| p.tile() == (12, 17))
    });
    assert!(
        reached,
        "un ordre manuel doit pouvoir sortir même pendant la défense"
    );
}

#[test]
fn un_chemin_d_assaut_deja_calcule_est_coupe_quand_la_porte_ferme() {
    let mut s = colony();
    for x in 10..13 {
        pawn(&mut s, (x, 6), Faction::Colony, Some(ItemKind::Spear));
    }
    let target = s.pawns().iter().find(|p| p.is_colonist()).unwrap().id;
    let raider = pawn(&mut s, (12, 15), Faction::Raider, None);
    s.pawn_mut(raider).unwrap().job = Job::Attack { target };
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Hold);
    assert!(!s.pawn_mut(raider).unwrap().path.is_empty());
    overwhelming_raid(&mut s);
    assert_eq!(s.raid_stance(), Stance::Watch);
    for _ in 0..900 {
        s.step(&[]);
        if let Some(p) = s.pawns().iter().find(|p| p.id == raider) {
            assert_eq!(s.map().room(p.tile().0, p.tile().1), 0);
        }
    }
}

#[test]
fn la_sauvegarde_en_defense_reprend_exactement_le_meme_raid() {
    let mut s = colony();
    for x in 10..13 {
        pawn(&mut s, (x, 10), Faction::Colony, Some(ItemKind::Spear));
    }
    let target = pawn(&mut s, DOOR, Faction::Raider, None);
    s.pawn_mut(target).unwrap().job = Job::Wait { until: u64::MAX };
    s.step(&[]);
    assert!(
        s.pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Defend { .. }))
    );
    let mut restored = Sim::restore(&s.snapshot()).unwrap();
    assert_eq!(restored.state_hash(), s.state_hash());
    for _ in 0..1_200 {
        s.step(&[]);
        restored.step(&[]);
        assert_eq!(restored.raid_status(), s.raid_status());
        assert_eq!(
            restored.state_hash(),
            s.state_hash(),
            "divergence au tick {}",
            s.tick()
        );
    }
}

#[test]
fn le_preavis_affiche_s_arrete_des_qu_un_assaillant_charge() {
    let mut s = colony();
    pawn(&mut s, (12, 6), Faction::Colony, None);
    assert_eq!(s.raid_status(), [0, 0, 0, 0, 0, u32::MAX]);
    overwhelming_raid(&mut s);
    let before = s.raid_status();
    assert_eq!(before[0], Stance::Watch as u32);
    assert_eq!(before[1], 6);
    assert_eq!(before[2], 600);
    let target = before[5];
    s.pawn_mut(target).unwrap().job = Job::Idle;
    assert_eq!(
        s.raid_status()[2],
        0,
        "un raid partiellement en marche est déjà actif"
    );
}

#[test]
fn la_porte_fermee_prouve_l_inaccessibilite_sans_explorer_toute_la_carte() {
    let mut s = colony();
    let walker = sim::path::Walker {
        avoids_doors: true,
        ..sim::path::Walker::ANYONE
    };
    s.map_mut().refresh_regions();
    assert_eq!(
        s.map().same_region_for((12, 15), (12, 7), walker),
        Some(false)
    );
    assert_eq!(
        sim::path::find_path_for(s.map(), (12, 15), (12, 7), walker),
        None
    );
    // Un départ sur le seuil reste capable de sortir.
    assert!(sim::path::find_path_for(s.map(), DOOR, (12, 15), walker).is_some());
    // Dès que le joueur démonte la porte, l'ancienne pièce ne prouve plus
    // rien. Le chemin doit rouvrir dès ce tick, avant le recalcul du toit.
    s.map_mut().set_feature(DOOR.0, DOOR.1, Feature::None);
    assert!(s.map().indoor_dirty());
    assert!(sim::path::find_path_for(s.map(), (12, 15), (12, 7), walker).is_some());
    s.map_mut().refresh_indoor();
    assert!(sim::path::find_path_for(s.map(), (12, 15), (12, 7), walker).is_some());
}

#[test]
fn une_colonie_muree_perd_le_stock_dehors_mais_pas_celui_dedans() {
    let mut s = colony();
    pawn(&mut s, (12, 6), Faction::Colony, None);
    s.spawn_item(ItemKind::Wood, 40, 12, 18);
    s.spawn_item(ItemKind::Stone, 30, 10, 6);
    overwhelming_raid(&mut s);
    for _ in 0..3_000 {
        s.step(&[]);
    }
    assert_eq!(
        s.items()
            .iter()
            .filter(|s| s.kind == ItemKind::Wood)
            .map(|s| s.count)
            .sum::<u32>(),
        20
    );
    assert_eq!(
        s.items()
            .iter()
            .filter(|s| s.kind == ItemKind::Stone)
            .map(|s| s.count)
            .sum::<u32>(),
        30
    );
    let loot: u32 = s
        .events()
        .iter()
        .filter(|e| e.kind == sim::EventKind::LootStolen)
        .map(|e| e.arg >> 8)
        .sum();
    assert_eq!(
        loot, 20,
        "une seule charge emportée ; le reste de la pile demeure"
    );
    assert_eq!(s.pawns().iter().filter(|p| p.is_colonist()).count(), 1);
}

#[test]
fn abattre_un_porteur_rend_sa_charge_et_ne_compte_pas_un_vol() {
    let mut s = colony();
    pawn(&mut s, (12, 6), Faction::Colony, None);
    s.spawn_item(ItemKind::Wood, 40, 12, 18);
    overwhelming_raid(&mut s);
    let thief = (0..1_200)
        .find_map(|_| {
            s.step(&[]);
            s.pawns()
                .iter()
                .find(|p| p.faction == Faction::Raider && p.carrying.is_some())
                .map(|p| p.id)
        })
        .expect("un pillard doit prendre une charge");
    let (at, load) = {
        let p = s.pawn_mut(thief).unwrap();
        let result = (p.tile(), p.carrying.unwrap());
        p.hp = 0;
        result
    };
    s.step(&[]);
    assert!(
        s.items()
            .iter()
            .any(|s| s.kind == load.0 && s.x == at.0 && s.y == at.1 && s.count >= load.1)
    );
    assert!(
        !s.events()
            .iter()
            .any(|e| e.kind == sim::EventKind::LootStolen)
    );
}

#[test]
fn le_pillage_resiste_au_snapshot_et_ne_duplique_pas_les_objets() {
    let mut s = colony();
    pawn(&mut s, (12, 6), Faction::Colony, None);
    s.spawn_item(ItemKind::Metal, 53, 12, 18);
    overwhelming_raid(&mut s);
    let started = (0..1_000).any(|_| {
        s.step(&[]);
        s.pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Pillage { .. }))
    });
    assert!(started);
    let mut restored = Sim::restore(&s.snapshot()).unwrap();
    for _ in 0..2_000 {
        s.step(&[]);
        restored.step(&[]);
    }
    assert_eq!(restored.state_hash(), s.state_hash());
    let left: u32 = s
        .items()
        .iter()
        .filter(|s| s.kind == ItemKind::Metal)
        .map(|s| s.count)
        .sum();
    let carried: u32 = s
        .pawns()
        .iter()
        .filter_map(|p| p.carrying)
        .filter(|(k, _)| *k == ItemKind::Metal)
        .map(|(_, n)| n)
        .sum();
    let stolen: u32 = s
        .events()
        .iter()
        .filter(|e| e.kind == sim::EventKind::LootStolen && (e.arg & 255) == ItemKind::Metal as u32)
        .map(|e| e.arg >> 8)
        .sum();
    assert_eq!(left + carried + stolen, 53);
    assert!(stolen > 0);
}
