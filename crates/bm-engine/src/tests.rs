use super::*;
use std::f64::consts::TAU;

const SR: f64 = 48_000.0;

/// A click every `beat_s`, starting at `first_s`, at `rate` Hz.
fn clicks(rate: f64, seconds: f64, beat_s: f64, first_s: f64) -> Track {
    let n = (seconds * rate) as usize;
    let mut x = vec![0.0f32; n];
    let mut t = first_s;
    while t < seconds {
        let i = (t * rate) as usize;
        for k in 0..32.min(n.saturating_sub(i)) {
            x[i + k] = 0.8 * (1.0 - k as f32 / 32.0);
        }
        t += beat_s;
    }
    Track::from_buffers(rate, x.clone(), x)
}

fn sine(rate: f64, seconds: f64, hz: f64) -> Track {
    let x: Vec<f32> = (0..(seconds * rate) as usize)
        .map(|i| (0.5 * (TAU * hz * i as f64 / rate).sin()) as f32)
        .collect();
    Track::from_buffers(rate, x.clone(), x)
}

fn load(e: &mut Engine, deck: u32, t: Track) {
    e.load_begin(deck, t.total, t.rate);
    e.load_push(deck, &t.left, &t.right);
}

/// Renders `seconds`; returns the master output (left).
fn run(e: &mut Engine, seconds: f64) -> Vec<f32> {
    let mut out = Vec::new();
    let mut left = (seconds * SR) as usize;
    let (mut a, mut b, mut c, mut d) = ([0.0; 128], [0.0; 128], [0.0; 128], [0.0; 128]);
    while left > 0 {
        let n = left.min(128);
        e.render([&mut a[..n], &mut b[..n]], [&mut c[..n], &mut d[..n]]);
        out.extend_from_slice(&a[..n]);
        left -= n;
    }
    out
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

#[test]
fn plays_at_the_tempo_set_and_converts_sample_rates() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(44_100.0, 30.0, 440.0));
    e.set(0, param::PLAY, 1.0);
    run(&mut e, 2.0);
    assert!((e.deck_state(0, param::S_POS) - 2.0).abs() < 0.01);
    e.set(0, param::TEMPO, 1.08);
    run(&mut e, 1.0);
    assert!((e.deck_state(0, param::S_POS) - 3.08).abs() < 0.01);
    assert!((e.deck_state(0, param::S_DURATION) - 30.0).abs() < 1e-9);
}

#[test]
fn pausing_fades_out_and_stops() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 10.0, 440.0));
    e.set(0, param::PLAY, 1.0);
    let out = run(&mut e, 0.5);
    assert!(rms(&out[2400..]) > 0.3);
    e.set(0, param::PLAY, 0.0);
    let out = run(&mut e, 0.1);
    // Not a hard cut: the first samples still sound, then silence.
    assert!(out[0].abs() > 0.0 || out[1].abs() > 0.0);
    assert!(rms(&out[1000..]) < 1e-6);
    let pos = e.deck_state(0, param::S_POS);
    run(&mut e, 0.5);
    assert_eq!(e.deck_state(0, param::S_POS), pos);
}

#[test]
fn a_loop_keeps_the_deck_between_its_ends() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 30.0, 440.0));
    e.set(0, param::LOOP_IN, 1.0);
    e.set(0, param::LOOP_OUT, 2.0);
    e.set(0, param::SEEK, 1.5);
    e.set(0, param::LOOP_ON, 1.0);
    e.set(0, param::PLAY, 1.0);
    for _ in 0..20 {
        run(&mut e, 0.3);
        let pos = e.deck_state(0, param::S_POS);
        assert!((1.0..2.0).contains(&pos), "{pos}");
    }
    e.set(0, param::LOOP_ON, 0.0);
    run(&mut e, 1.0);
    assert!(e.deck_state(0, param::S_POS) > 2.0);
}

#[test]
fn slip_returns_to_where_the_track_would_have_been() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 30.0, 440.0));
    e.set(0, param::SLIP, 1.0);
    e.set(0, param::LOOP_IN, 1.0);
    e.set(0, param::LOOP_OUT, 1.5);
    e.set(0, param::SEEK, 1.0);
    e.set(0, param::LOOP_ON, 1.0);
    e.set(0, param::PLAY, 1.0);
    run(&mut e, 3.0);
    e.set(0, param::LOOP_ON, 0.0);
    run(&mut e, 0.01);
    let pos = e.deck_state(0, param::S_POS);
    assert!((pos - 4.01).abs() < 0.01, "{pos}");
}

#[test]
fn the_track_stops_at_its_end() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 1.0, 440.0));
    e.set(0, param::PLAY, 1.0);
    run(&mut e, 2.0);
    assert_eq!(e.deck_state(0, param::S_PLAYING), 0.0);
    assert!((e.deck_state(0, param::S_POS) - 1.0).abs() < 1e-6);
}

#[test]
fn sync_matches_tempo_and_beats() {
    let mut e = Engine::new(SR);
    // Master at 128 BPM, the other at 125 BPM with its beats somewhere else.
    let (b1, b2) = (60.0 / 128.0, 60.0 / 125.0);
    load(&mut e, 0, clicks(SR, 60.0, b1, 0.1));
    load(&mut e, 1, clicks(44_100.0, 60.0, b2, 0.37));
    e.set(0, param::BEAT, b1);
    e.set(0, param::ANCHOR, 0.1);
    e.set(1, param::BEAT, b2);
    e.set(1, param::ANCHOR, 0.37);
    e.set(0, param::MASTER, 1.0);
    e.set(0, param::PLAY, 1.0);
    run(&mut e, 1.0);
    e.set(1, param::SYNC, 1.0);
    e.set(1, param::SEEK, 5.0);
    e.set(1, param::PLAY, 1.0);
    run(&mut e, 10.0);
    let tempo = e.deck_state(1, param::S_TEMPO);
    assert!((tempo - 128.0 / 125.0).abs() < 1e-9, "{tempo}");
    // Phase: the two decks' beats line up.
    let phase = |deck: usize, beat: f64, anchor: f64| {
        ((e.deck_state(deck, param::S_POS) - anchor) / beat).rem_euclid(1.0)
    };
    let d = (phase(0, b1, 0.1) - phase(1, b2, 0.37) + 0.5).rem_euclid(1.0) - 0.5;
    assert!(d.abs() < 0.01, "{d} beats apart");
}

#[test]
fn sync_plays_half_tempo_tracks_at_their_own_speed() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, clicks(SR, 30.0, 60.0 / 174.0, 0.0));
    load(&mut e, 1, clicks(SR, 30.0, 60.0 / 86.0, 0.0));
    e.set(0, param::BEAT, 60.0 / 174.0);
    e.set(1, param::BEAT, 60.0 / 86.0);
    e.set(0, param::MASTER, 1.0);
    e.set(1, param::SYNC, 1.0);
    e.set(0, param::PLAY, 1.0);
    e.set(1, param::PLAY, 1.0);
    run(&mut e, 0.5);
    let tempo = e.deck_state(1, param::S_TEMPO);
    assert!((tempo - 87.0 / 86.0).abs() < 1e-9, "{tempo}");
}

#[test]
fn eq_kills_and_fader_mutes() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 10.0, 60.0));
    e.set(0, param::PLAY, 1.0);
    let open = rms(&run(&mut e, 0.5)[12_000..]);
    e.set(0, param::EQ_LOW, 0.0);
    let killed = rms(&run(&mut e, 0.5)[12_000..]);
    assert!(killed < open * 0.1, "{open} {killed}");
    e.set(0, param::EQ_LOW, 1.0);
    e.set(0, param::VOLUME, 0.0);
    let muted = rms(&run(&mut e, 0.5)[12_000..]);
    assert!(muted < 1e-4);
}

#[test]
fn scratching_moves_with_the_hand() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 30.0, 440.0));
    e.set(0, param::SEEK, 10.0);
    e.set(0, param::SCRATCH, 1.0);
    e.set(0, param::SCRATCH_SPEED, -1.0);
    run(&mut e, 1.0);
    let pos = e.deck_state(0, param::S_POS);
    // Backwards about a second, less the time it takes to get up to speed.
    assert!((8.9..9.1).contains(&pos), "{pos}");
}

#[test]
fn echo_rings_on_after_it_is_switched_off() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 2.0, 440.0));
    e.set(GLOBAL, G_FX_TYPE, fx::ECHO as f64);
    e.set(GLOBAL, G_FX_TARGET, 0.0);
    e.set(GLOBAL, G_FX_BEATS, 0.5);
    e.set(GLOBAL, G_FX_ON, 1.0);
    e.set(0, param::PLAY, 1.0);
    run(&mut e, 1.9);
    e.set(GLOBAL, G_FX_ON, 0.0);
    run(&mut e, 0.2);
    // The track has ended; the echo goes on.
    assert_eq!(e.deck_state(0, param::S_PLAYING), 0.0);
    let tail = run(&mut e, 0.5);
    assert!(rms(&tail) > 0.01);
}

#[test]
fn headphones_hear_the_cued_deck_with_its_fader_down() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 5.0, 440.0));
    e.set(0, param::VOLUME, 0.0);
    e.set(0, param::CUE, 1.0);
    e.set(0, param::PLAY, 1.0);
    let n = 128;
    let (mut a, mut b, mut c, mut d) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    let mut phones = Vec::new();
    for _ in 0..200 {
        e.render([&mut a, &mut b], [&mut c, &mut d]);
        phones.extend_from_slice(&c);
    }
    assert!(rms(&phones[10_000..]) > 0.2);
    assert!(rms(&a) < 1e-4);
}
