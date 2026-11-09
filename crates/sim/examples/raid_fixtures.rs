//! Génère trois parties de contrôle pour la parité et la vérification visuelle.
//! cargo run -p sim --example raid_fixtures -- <répertoire de sortie>
//! Les empreintes sont calculées en natif ; le test WASM relit les mêmes fichiers.
use sim::fixed::FX_HALF;
use sim::map::{Feature, Zone};
use sim::pawn::{Job, NEED_MAX};
use sim::testmap::map_from;
use sim::{Command, Faction, ItemKind, Sim};
use std::path::Path;

fn pawn(s: &mut Sim, at: (u32, u32), faction: Faction, weapon: Option<ItemKind>) -> u32 {
    let id = s.spawn_pawn(at.0, at.1, faction);
    let p = s.pawn_mut(id).unwrap();
    p.traits = [None, None];
    p.hunger = NEED_MAX;
    p.rest = NEED_MAX;
    p.weapon = weapon;
    id
}

fn fixture(watch: bool) -> Sim {
    let mut s = Sim::from_map_scaled(17, map_from(&[&".".repeat(64) as &str; 64]), 30);
    let ids: Vec<_> = s.pawns().iter().map(|p| p.id).collect();
    for id in ids {
        s.pawn_mut(id).unwrap().gone = true;
    }
    s.step(&[]);
    for n in 26..=38 {
        s.map_mut().set_feature(n, 23, Feature::WallWood);
        s.map_mut().set_feature(n, 35, Feature::WallWood);
    }
    for n in 23..=35 {
        s.map_mut().set_feature(26, n, Feature::WallWood);
        s.map_mut().set_feature(38, n, Feature::WallWood);
    }
    s.map_mut().set_feature(32, 35, Feature::DoorWood);
    for x in 28..31 {
        s.map_mut().set_feature(x, 25, Feature::Bed);
    }
    s.map_mut().refresh_indoor();
    s.spawn_item(ItemKind::Berries, 100, 28, 28);
    s.spawn_item(ItemKind::Wood, 40, 34, 40);
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 28,
        y0: 28,
        x1: 28,
        y1: 28,
    }]);
    for x in 30..33 {
        pawn(
            &mut s,
            (x, 31),
            Faction::Colony,
            if watch { None } else { Some(ItemKind::Spear) },
        );
    }
    if watch {
        let until = s.tick() + u64::from(s.ticks_per_day() / 24);
        for x in 29..35 {
            let id = pawn(&mut s, (x, 46), Faction::Raider, Some(ItemKind::Spear));
            s.pawn_mut(id).unwrap().job = Job::Wait { until };
        }
    } else {
        let id = pawn(&mut s, (32, 35), Faction::Raider, None);
        s.pawn_mut(id).unwrap().job = Job::Wait { until: u64::MAX };
        // Un colon à portée déclenche Defend : le snapshot couvre réellement
        // la variante ajoutée, pas seulement le calcul de posture.
        let hero = s.pawns().iter().find(|p| p.is_colonist()).unwrap().id;
        s.pawn_mut(hero).unwrap().x = 32 * 256 + FX_HALF;
        s.pawn_mut(hero).unwrap().y = 33 * 256 + FX_HALF;
    }
    s.step(&[]);
    s
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("répertoire de sortie requis")?;
    let directory = Path::new(&directory);
    std::fs::create_dir_all(directory)?;
    for (name, watch, ticks) in [
        ("raid-watch", true, 20_000),
        ("raid-hold", false, 1_200),
        ("raid-return", true, 12_000),
    ] {
        let mut s = fixture(watch);
        if name == "raid-return" {
            let ids: Vec<_> = s
                .pawns()
                .iter()
                .filter(|p| p.is_colonist())
                .map(|p| p.id)
                .collect();
            for (n, id) in ids.into_iter().enumerate() {
                let p = s.pawn_mut(id).unwrap();
                p.x = (2 + n as i32) * 256 + FX_HALF;
                p.y = 2 * 256 + FX_HALF;
                p.path.clear();
                p.job = Job::Idle;
            }
        }
        std::fs::write(directory.join(format!("{name}.bin")), s.snapshot())?;
        std::fs::write(directory.join(format!("{name}.ticks")), ticks.to_string())?;
        for _ in 0..ticks {
            s.step(&[]);
        }
        std::fs::write(
            directory.join(format!("{name}.hash")),
            format!("{:016x}\n", s.state_hash()),
        )?;
        println!(
            "{name}: {ticks} ticks, {:016x}, statut {:?}",
            s.state_hash(),
            s.raid_status()
        );
    }
    Ok(())
}
