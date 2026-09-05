//! Relations entre colons : opinions, bavardage, disputes et rixes.
//!
//! Les scénarios se jouent dans une pièce fermée de neuf cases : personne ne
//! s'éloigne en flânant, tout le monde reste à portée de voix, et il n'y a
//! **aucun travail** à faire — ni arbre, ni buisson, ni chantier, ni objet à
//! ranger. On ne mesure donc que la vie sociale.

use sim::combat::GRIEF_TICKS;
use sim::health::SEVERITY_MAX;
use sim::pawn::{HP_MAX, NEED_MAX};
use sim::social::{
    CHAT_COOLDOWN, CHAT_MOOD_BONUS, CHAT_OPINION, CHAT_TICKS, FRIEND_MOOD_BONUS, FRIEND_OPINION,
    MAX_OPINIONS, MOOD_SOCIAL_CAP, OPINION_MAX, OPINION_MIN, QUARREL_OPINION, RIVAL_MOOD_MALUS,
    RIVAL_OPINION,
};
use sim::testmap::map_from;
use sim::{BodyPart, EventKind, Sim, Trait};

const DAY: u64 = sim::TICKS_PER_DAY as u64;

/// Pièce fermée de 3×3 : les trois colons de départ y naissent côte à côte et
/// ne peuvent pas s'en éloigner.
fn small_room(seed: u64) -> Sim {
    let map = map_from(&["#####", "#...#", "#...#", "#...#", "#####"]);
    let mut s = Sim::from_map(seed, map);
    // Le hasard des traits ne doit pas décider du résultat : un sociable
    // bavarderait deux fois plus vite, un bagarreur se disputerait deux fois
    // plus souvent.
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    for id in ids {
        s.pawn_mut(id).unwrap().traits = [None, None];
    }
    s
}

/// Même pièce, réduite à `keep` colons : les autres quittent la carte sans
/// mourir (ni cadavre, ni deuil, ni événement).
fn room_with(seed: u64, keep: usize) -> (Sim, Vec<u32>) {
    let mut s = small_room(seed);
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    for &id in &ids[keep..] {
        s.pawn_mut(id).unwrap().gone = true;
    }
    s.step(&[]);
    (s, ids[..keep].to_vec())
}

/// Repus et reposés : une journée entière sans faim ni sommeil, sinon les
/// colons partiraient manger (il n'y a rien) puis dormir, et l'humeur mesurée
/// parlerait de leur ventre, pas de leurs amis.
fn keep_comfortable(s: &mut Sim, ids: &[u32]) {
    for &id in ids {
        let Some(p) = s.pawn_mut(id) else { continue };
        p.hunger = NEED_MAX;
        p.rest = NEED_MAX;
    }
}

fn mood_of(s: &Sim, id: u32) -> u32 {
    s.pawns().iter().find(|p| p.id == id).unwrap().mood()
}

fn opinion(s: &Sim, from: u32, to: u32) -> i32 {
    s.pawns()
        .iter()
        .find(|p| p.id == from)
        .map_or(0, |p| p.opinion_of(to))
}

/// Avance d'un tick et récolte les événements apparus, `MAX_EVENTS` ne gardant
/// que les derniers.
fn step_collect(s: &mut Sim, seen: &mut u32, out: &mut Vec<(EventKind, u32)>) {
    s.step(&[]);
    for e in s.events() {
        if e.seq >= *seen {
            out.push((e.kind, e.arg));
            *seen = e.seq + 1;
        }
    }
}

#[test]
fn idle_neighbours_chat_and_like_each_other() {
    let (mut duo, ids) = room_with(1, 2);
    let (a, b) = (ids[0], ids[1]);
    // Sim jumelle : même carte, même graine, un seul colon. Au premier
    // bavardage terminé (une centaine de ticks), la météo n'a pas encore
    // changé dans l'une ni dans l'autre : tout ce qui sépare les deux humeurs
    // est le souvenir de la conversation.
    let (mut solo, lonely) = {
        let (s, ids) = room_with(1, 1);
        let id = ids[0];
        (s, id)
    };

    let mut social_seen = false;
    let mut measured: Option<(u32, u32)> = None;
    for _ in 0..DAY {
        keep_comfortable(&mut duo, &[a, b]);
        keep_comfortable(&mut solo, &[lonely]);
        duo.step(&[]);
        solo.step(&[]);
        let p = duo.pawns().iter().find(|p| p.id == a).unwrap();
        if p.social_ticks > 0 {
            social_seen = true;
            if measured.is_none() && p.quarrel_ticks == 0 {
                measured = Some((mood_of(&duo, a), mood_of(&solo, lonely)));
            }
        }
    }

    assert!(
        social_seen,
        "aucun souvenir de conversation en une journée côte à côte"
    );
    let (chatty, alone) = measured.expect("aucune conversation qui se passe bien en une journée");
    assert_eq!(
        i64::from(chatty) - i64::from(alone),
        CHAT_MOOD_BONUS,
        "humeur du bavard {chatty}, du solitaire {alone}"
    );
    assert!(
        opinion(&duo, a, b) > 0 && opinion(&duo, b, a) > 0,
        "après une journée de voisinage : {} et {}",
        opinion(&duo, a, b),
        opinion(&duo, b, a)
    );
}

/// Nombre de conversations tenues en un jour par la paire, comptées aux
/// changements d'avis (chaque fin de bavardage en fait bouger un).
fn chats_in_a_day(seed: u64, initiator_trait: Option<Trait>) -> u64 {
    let (mut s, ids) = room_with(seed, 2);
    let (a, b) = (ids[0], ids[1]);
    s.pawn_mut(a).unwrap().traits = [initiator_trait, None];
    let mut chats = 0;
    let mut last = opinion(&s, a, b);
    for _ in 0..DAY {
        keep_comfortable(&mut s, &[a, b]);
        s.step(&[]);
        let now = opinion(&s, a, b);
        if now != last {
            chats += 1;
            last = now;
        }
    }
    chats
}

#[test]
fn chat_cooldown_limits_frequency() {
    let chats = chats_in_a_day(2, None);
    // Une conversation dure `CHAT_TICKS` et la suivante attend `CHAT_COOLDOWN` :
    // impossible d'en tenir davantage, même en restant collés toute la journée.
    let bound = DAY / u64::from(CHAT_TICKS + CHAT_COOLDOWN) + 1;
    assert!(
        chats > 0,
        "aucune conversation en une journée : le délai bloque tout"
    );
    assert!(
        chats <= bound,
        "{chats} conversations en un jour, borne théorique {bound}"
    );
}

#[test]
fn a_sociable_renews_the_conversation_twice_as_fast() {
    let plain = chats_in_a_day(2, None);
    let sociable = chats_in_a_day(2, Some(Trait::Sociable));
    // Le délai de celui qui engage est divisé par deux : à `CHAT_TICKS` près,
    // deux fois plus de conversations dans la journée.
    assert!(
        sociable > plain * 3 / 2,
        "sociable {sociable} conversations, ordinaire {plain}"
    );
}

#[test]
fn friends_lift_the_mood_and_rivals_weigh_it_down() {
    let (mut s, ids) = room_with(7, 1);
    let me = ids[0];
    let base = mood_of(&s, me);
    // Trois amis, mais le plafond n'en compte que deux.
    for other in 100..103 {
        s.set_opinion_for_tests(me, other, FRIEND_OPINION);
    }
    assert_eq!(
        i64::from(mood_of(&s, me)) - i64::from(base),
        i64::from(MOOD_SOCIAL_CAP) * FRIEND_MOOD_BONUS,
        "trois amis devraient valoir le plafond de deux"
    );
    // Trois rivaux, même plafond dans l'autre sens.
    s.pawn_mut(me).unwrap().opinions.clear();
    for other in 200..203 {
        s.set_opinion_for_tests(me, other, RIVAL_OPINION);
    }
    assert_eq!(
        i64::from(base) - i64::from(mood_of(&s, me)),
        i64::from(MOOD_SOCIAL_CAP) * RIVAL_MOOD_MALUS,
        "trois rivaux devraient peser le plafond de deux"
    );
    // Juste au-dessus des seuils : ni ami, ni rival.
    s.pawn_mut(me).unwrap().opinions.clear();
    s.set_opinion_for_tests(me, 300, FRIEND_OPINION - 1);
    s.set_opinion_for_tests(me, 301, RIVAL_OPINION + 1);
    assert_eq!(mood_of(&s, me), base, "les tièdes ne changent rien");
}

#[test]
fn quarrels_happen_and_hurt_opinion() {
    let mut days_with_quarrel = 0;
    for seed in 1..=20u64 {
        let (mut s, ids) = room_with(seed, 2);
        let (a, b) = (ids[0], ids[1]);
        let mut seen = 0;
        let mut events = Vec::new();
        for _ in 0..DAY {
            keep_comfortable(&mut s, &[a, b]);
            step_collect(&mut s, &mut seen, &mut events);
        }
        let quarrels = events
            .iter()
            .filter(|(k, _)| *k == EventKind::Quarrel)
            .count();
        if quarrels > 0 {
            days_with_quarrel += 1;
            // Une dispute laisse une trace : l'avis a forcément reculé d'au
            // moins `QUARREL_OPINION` par rapport aux seuls bavardages réussis.
            assert!(
                opinion(&s, a, b) <= (quarrels as i32) * QUARREL_OPINION + 20 * CHAT_OPINION,
                "graine {seed} : {quarrels} disputes et pourtant {} d'avis",
                opinion(&s, a, b)
            );
        }
        // Deux colons qui partent d'une opinion neutre ne peuvent pas en venir
        // aux mains dès le premier jour.
        assert!(
            !events.iter().any(|(k, _)| *k == EventKind::Brawl),
            "graine {seed} : rixe alors que les avis partaient de zéro"
        );
    }
    assert!(
        days_with_quarrel > 10,
        "seulement {days_with_quarrel} graines sur 20 avec une dispute dans la journée"
    );
}

#[test]
fn long_rivalry_ends_in_a_brawl() {
    let (mut s, ids) = room_with(3, 2);
    let (a, b) = (ids[0], ids[1]);
    let mut seen = 0;
    let mut events = Vec::new();
    let mut brawled = false;
    for _ in 0..10 * DAY {
        keep_comfortable(&mut s, &[a, b]);
        // Une inimitié qui dure : on la maintient plutôt que de jouer les
        // milliers de ticks qui l'auraient creusée. `set_opinion_for_tests` ne
        // touche pas au tick de la dernière conversation : le délai entre deux
        // bavardages continue de jouer.
        s.set_opinion_for_tests(a, b, -70);
        s.set_opinion_for_tests(b, a, -70);
        step_collect(&mut s, &mut seen, &mut events);
        if events.iter().any(|(k, _)| *k == EventKind::Brawl) {
            brawled = true;
            break;
        }
    }
    assert!(brawled, "aucune rixe entre deux colons qui se détestent");
    // La rixe suit la dispute, et parle des deux mêmes.
    let quarrel = events.iter().rposition(|(k, _)| *k == EventKind::Quarrel);
    let brawl = events.iter().rposition(|(k, _)| *k == EventKind::Brawl);
    assert!(quarrel < brawl, "la rixe précède la dispute : {events:?}");
    assert_eq!(
        events[brawl.unwrap()].1,
        a.min(b),
        "la rixe désigne quelqu'un d'autre"
    );
    for &id in &[a, b] {
        let p = s.pawns().iter().find(|p| p.id == id).unwrap();
        assert!(
            !p.injuries.is_empty() && p.hp < HP_MAX,
            "le colon {id} sort d'une rixe sans une égratignure ({} PV)",
            p.hp
        );
    }
    assert_eq!(s.pawns().len(), 2, "une rixe a tué quelqu'un");
}

#[test]
fn friends_grieve_twice_as_long() {
    let mut s = small_room(4);
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    let (friend, victim, stranger) = (ids[0], ids[1], ids[2]);
    s.set_opinion_for_tests(friend, victim, 60);
    // Un coup fatal au torse, comme dans les tests de santé.
    s.inflict_injury(victim, BodyPart::Torso, SEVERITY_MAX);
    s.step(&[]);

    assert!(
        !s.pawns().iter().any(|p| p.id == victim),
        "la victime est toujours là"
    );
    let grief = |s: &Sim, id: u32| s.pawns().iter().find(|p| p.id == id).unwrap().grief_ticks;
    // Le deuil est décompté d'un tick par `tick_health` au tick suivant : on
    // compare à la valeur posée, à un tick près.
    assert_eq!(
        grief(&s, friend),
        2 * GRIEF_TICKS,
        "l'ami ne porte pas un deuil double"
    );
    assert_eq!(
        grief(&s, stranger),
        GRIEF_TICKS,
        "un colon indifférent porte un deuil allongé"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::FriendLost && e.arg == friend),
        "aucune perte d'ami annoncée : {:?}",
        s.events()
    );
    assert!(
        !s.events()
            .iter()
            .any(|e| e.kind == EventKind::FriendLost && e.arg == stranger),
        "l'indifférent est annoncé comme endeuillé"
    );
    // L'avis qu'on avait du mort s'efface : il ne pèse plus sur l'humeur.
    assert_eq!(opinion(&s, friend, victim), 0);
}

#[test]
fn opinions_are_bounded_and_capped() {
    let (mut s, ids) = room_with(5, 1);
    let me = ids[0];
    // Bornes : on ne peut pas adorer ni haïr au-delà.
    s.set_opinion_for_tests(me, 1_000, 5_000);
    s.set_opinion_for_tests(me, 1_001, -5_000);
    assert_eq!(opinion(&s, me, 1_000), OPINION_MAX);
    assert_eq!(opinion(&s, me, 1_001), OPINION_MIN);

    // Vingt connaissances : seules les seize plus marquantes restent, et la
    // plus tiède part la première.
    for k in 0..20u32 {
        s.set_opinion_for_tests(me, 2_000 + k, 10 + k as i32);
    }
    let p = s.pawns().iter().find(|p| p.id == me).unwrap();
    assert_eq!(p.opinions.len(), MAX_OPINIONS, "avis : {:?}", p.opinions);
    assert!(
        p.opinions.iter().all(|o| o.value.abs() <= OPINION_MAX),
        "un avis a débordé : {:?}",
        p.opinions
    );
    // Les deux extrêmes du début ont tenu, les tièdes du milieu non.
    assert_eq!(opinion(&s, me, 1_000), OPINION_MAX);
    assert_eq!(opinion(&s, me, 1_001), OPINION_MIN);
    assert_eq!(
        opinion(&s, me, 2_000),
        0,
        "le plus tiède aurait dû s'effacer"
    );
    assert_eq!(opinion(&s, me, 2_019), 29, "le plus marquant a disparu");
}

#[test]
fn snapshot_keeps_opinions() {
    let (mut s, ids) = room_with(6, 2);
    let (a, b) = (ids[0], ids[1]);
    // Une vraie conversation, jouée : l'avis et le tick de la dernière
    // rencontre doivent traverser le snapshot.
    for _ in 0..(CHAT_TICKS as u64 + 10) {
        keep_comfortable(&mut s, &[a, b]);
        s.step(&[]);
    }
    assert_ne!(opinion(&s, a, b), 0, "aucune conversation à sauvegarder");
    let before: Vec<sim::Opinion> = s
        .pawns()
        .iter()
        .find(|p| p.id == a)
        .unwrap()
        .opinions
        .clone();

    let bytes = s.snapshot();
    let restored = Sim::restore(&bytes).expect("snapshot relu");
    let after = &restored
        .pawns()
        .iter()
        .find(|p| p.id == a)
        .unwrap()
        .opinions;
    assert_eq!(&before, after, "les avis n'ont pas survécu au snapshot");
    assert_eq!(restored, s);
    assert_eq!(restored.state_hash(), s.state_hash());
}
