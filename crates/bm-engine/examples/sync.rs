//! Syncs two real tracks the way the app does and prints how far apart their beats
//! are over time: `cargo run --release -p bm-engine --example sync -- MASTER OTHER`

use bm_engine::{param::*, Engine};

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    let sr = 48_000.0;
    let mut e = Engine::new(sr);
    let mut grids = Vec::new();
    for (k, path) in paths.iter().enumerate() {
        let bytes = std::fs::read(path).unwrap();
        let ext = path.rsplit('.').next().map(str::to_owned);
        let d = bm_decode::decode(bytes, ext.as_deref(), false).unwrap();
        let mono: Vec<f32> = d
            .left
            .iter()
            .zip(&d.right)
            .map(|(l, r)| 0.5 * (l + r))
            .collect();
        let a = bm_analysis::analyse(&mono, d.rate, Default::default());
        println!(
            "deck {k}: {:.3} BPM, anchor {:.4}, rate {}",
            a.bpm, a.anchor_s, d.rate
        );
        e.load_begin(k as u32, d.left.len(), d.rate as f64);
        e.load_push(k as u32, &d.left, &d.right);
        e.set(k as u32, BEAT, 60.0 / a.bpm);
        e.set(k as u32, ANCHOR, a.anchor_s);
        grids.push((60.0 / a.bpm, a.anchor_s));
    }
    e.set(0, MASTER, 1.0);
    e.set(0, SEEK, 30.0);
    e.set(0, PLAY, 1.0);
    e.set(1, SEEK, 60.0);
    let mut buf = vec![vec![0.0f32; 128]; 4];
    let mut render = |e: &mut Engine, seconds: f64| {
        for _ in 0..(seconds * sr / 128.0) as usize {
            let [a, b, c, d] = &mut buf[..] else {
                unreachable!()
            };
            e.render([a, b], [c, d]);
        }
    };
    render(&mut e, 2.0);
    e.set(1, SYNC, 1.0);
    e.set(1, PLAY, 1.0);
    for step in 0..12 {
        render(&mut e, 5.0);
        let phase = |k: usize| {
            let (beat, anchor) = grids[k];
            ((e.deck_state(k, S_POS) - anchor) / beat).rem_euclid(1.0)
        };
        let diff = (phase(0) - phase(1) + 0.5).rem_euclid(1.0) - 0.5;
        println!(
            "t={:>3}s  deck1 {:.3}s  deck2 {:.3}s  tempo2 {:.5}  engine phase err {:+.4}  measured {:+.4} beats ({:+.1} ms)",
            (step + 1) * 5,
            e.deck_state(0, S_POS),
            e.deck_state(1, S_POS),
            e.deck_state(1, S_TEMPO),
            e.deck_state(1, S_PHASE),
            diff,
            diff * grids[0].0 * 1e3
        );
    }
}
