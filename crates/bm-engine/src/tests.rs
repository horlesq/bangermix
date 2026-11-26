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

/// Frequency from zero crossings.
fn freq(x: &[f32]) -> f64 {
    let crossings = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
    crossings as f64 / (x.len() as f64 / SR)
}

#[test]
fn keylock_keeps_the_pitch_at_a_faster_tempo() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(44_100.0, 30.0, 440.0));
    e.set(0, param::TEMPO, 1.06);
    e.set(0, param::PLAY, 1.0);
    let plain = run(&mut e, 1.0);
    assert!((freq(&plain[4800..]) - 440.0 * 1.06).abs() < 4.0);
    e.set(0, param::KEYLOCK, 1.0);
    let locked = run(&mut e, 2.0);
    let f = freq(&locked[9600..]);
    assert!((f - 440.0).abs() < 4.0, "{f} Hz");
    assert!((e.deck_state(0, param::S_PITCH) - 1.0).abs() < 1e-9);
    // The tempo still moves the deck on at 1.06.
    assert!((e.deck_state(0, param::S_POS) - 3.0 * 1.06).abs() < 0.01);
}

#[test]
fn key_shift_changes_the_pitch_only() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 30.0, 440.0));
    e.set(0, param::KEY_SHIFT, -1.0);
    e.set(0, param::PLAY, 1.0);
    let out = run(&mut e, 2.0);
    let f = freq(&out[9600..]);
    let want = 440.0 * 2f64.powf(-1.0 / 12.0);
    assert!((f - want).abs() < 4.0, "{f} Hz, want {want}");
    assert!((e.deck_state(0, param::S_POS) - 2.0).abs() < 0.01);
}

#[test]
fn loops_and_jumps_work_with_keylock() {
    let mut e = Engine::new(SR);
    load(&mut e, 0, sine(SR, 30.0, 440.0));
    e.set(0, param::KEYLOCK, 1.0);
    e.set(0, param::TEMPO, 0.95);
    e.set(0, param::LOOP_IN, 1.0);
    e.set(0, param::LOOP_OUT, 2.0);
    e.set(0, param::SEEK, 1.2);
    e.set(0, param::LOOP_ON, 1.0);
    e.set(0, param::PLAY, 1.0);
    for _ in 0..10 {
        let out = run(&mut e, 0.5);
        let pos = e.deck_state(0, param::S_POS);
        assert!((1.0..2.0).contains(&pos), "{pos}");
        assert!(rms(&out) > 0.3, "no dropouts");
    }
}

/// `cargo test --release -p bm-engine -- --ignored --nocapture keylock_cost`
#[test]
#[ignore]
fn keylock_cost() {
    let mut e = Engine::new(SR);
    for d in 0..4 {
        load(&mut e, d, sine(44_100.0, 60.0, 220.0 + 50.0 * d as f64));
        e.set(d, param::KEYLOCK, 1.0);
        e.set(d, param::TEMPO, 1.04);
        e.set(d, param::PLAY, 1.0);
    }
    let t = std::time::Instant::now();
    run(&mut e, 20.0);
    let s = t.elapsed().as_secs_f64();
    for d in 0..4 {
        e.set(d, param::KEYLOCK, 0.0);
    }
    let t2 = std::time::Instant::now();
    run(&mut e, 20.0);
    let s2 = t2.elapsed().as_secs_f64();
    println!(
        "4 plain decks: {:.1} ms per second of audio",
        s2 / 20.0 * 1e3
    );
    println!(
        "4 keylocked decks: {:.1} ms per second of audio ({:.1}% of one core)",
        s / 20.0 * 1e3,
        s / 20.0 * 100.0
    );
}

#[test]
fn sync_lines_up_downbeats() {
    let mut e = Engine::new(SR);
    // Same tempo; the second track's downbeat is one beat later in its file.
    let beat = 60.0 / 174.0;
    load(&mut e, 0, clicks(SR, 60.0, beat, 0.2));
    load(&mut e, 1, clicks(SR, 60.0, beat, 0.2 + beat));
    e.set(0, param::BEAT, beat);
    e.set(0, param::ANCHOR, 0.2);
    e.set(1, param::BEAT, beat);
    e.set(1, param::ANCHOR, 0.2 + beat);
    e.set(0, param::MASTER, 1.0);
    e.set(0, param::PLAY, 1.0);
    // Started on the same file position, deck 2 sits one beat off in its bar.
    e.set(1, param::SYNC, 1.0);
    e.set(1, param::PLAY, 1.0);
    run(&mut e, 4.0);
    let bar_pos = |deck: usize, anchor: f64| {
        ((e.deck_state(deck, param::S_POS) - anchor) / beat).rem_euclid(4.0)
    };
    let d = (bar_pos(0, 0.2) - bar_pos(1, 0.2 + beat) + 2.0).rem_euclid(4.0) - 2.0;
    assert!(d.abs() < 0.01, "{d} beats apart in the bar");
}

#[test]
fn a_synced_deck_lands_on_the_beat_after_a_jump() {
    let mut e = Engine::new(SR);
    let beat = 60.0 / 174.0;
    load(&mut e, 0, clicks(SR, 60.0, beat, 0.2));
    load(&mut e, 1, clicks(SR, 60.0, beat, 0.2));
    for d in 0..2 {
        e.set(d, param::BEAT, beat);
        e.set(d, param::ANCHOR, 0.2);
    }
    e.set(0, param::MASTER, 1.0);
    e.set(0, param::PLAY, 1.0);
    e.set(1, param::SYNC, 1.0);
    e.set(1, param::PLAY, 1.0);
    run(&mut e, 2.0);
    // Jump a third of a beat off, then one whole beat: the first is corrected at
    // once, the second kept (beats line up, the bar position moves).
    e.set(1, param::SEEK, e.deck_state(1, param::S_POS) + beat / 3.0);
    run(&mut e, 0.05);
    assert!(e.deck_state(1, param::S_PHASE).abs() < 0.01);
    let before = e.deck_state(1, param::S_POS);
    e.set(1, param::SEEK, before + beat);
    run(&mut e, 3.0);
    let beat_in_bar = |d: usize| ((e.deck_state(d, param::S_POS) - 0.2) / beat).rem_euclid(4.0);
    let off = (beat_in_bar(1) - beat_in_bar(0)).rem_euclid(4.0);
    assert!(
        (off - 1.0).abs() < 0.02,
        "deck 2 is {off} beats on in the bar"
    );
}

/// A deck playing `t` with a master grid at 120 BPM.
fn playing(t: Track) -> Engine {
    let mut e = Engine::new(SR);
    load(&mut e, 0, t);
    e.set(0, param::BEAT, 0.5);
    e.set(0, param::ANCHOR, 0.0);
    e.set(0, param::MASTER, 1.0);
    e.set(0, param::PLAY, 1.0);
    e
}

fn noise(rate: f64, seconds: f64) -> Track {
    let mut s = 12345u32;
    let x: Vec<f32> = (0..(seconds * rate) as usize)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            0.3 * (s as f32 / u32::MAX as f32 * 2.0 - 1.0)
        })
        .collect();
    Track::from_buffers(rate, x.clone(), x)
}

fn sound(x: &[f32]) -> bool {
    x.iter().all(|v| v.is_finite() && v.abs() < 2.0)
}

#[test]
fn every_color_fx_changes_the_sound_both_ways_and_is_off_in_the_centre() {
    for kind in [
        color::FILTER,
        color::SPACE,
        color::DUB_ECHO,
        color::SWEEP,
        color::NOISE,
        color::CRUSH,
    ] {
        for side in [-0.8, 0.8] {
            let mut dry = playing(clicks(SR, 6.0, 0.5, 0.0));
            let mut wet = playing(clicks(SR, 6.0, 0.5, 0.0));
            wet.set(GLOBAL, param::G_COLOR_TYPE, kind as f64);
            wet.set(0, param::FILTER, side);
            let a = run(&mut dry, 2.0);
            let b = run(&mut wet, 2.0);
            assert!(sound(&b), "kind {kind} side {side}: not finite or too loud");
            let diff = rms(&a.iter().zip(&b).map(|(x, y)| x - y).collect::<Vec<_>>());
            assert!(
                diff > 0.01 * rms(&a),
                "kind {kind} side {side}: no change ({diff})"
            );
        }
        // Centred, the dry-only effects pass the sound untouched.
        if [color::FILTER, color::SWEEP, color::NOISE, color::CRUSH].contains(&kind) {
            let mut dry = playing(sine(SR, 3.0, 440.0));
            let mut wet = playing(sine(SR, 3.0, 440.0));
            wet.set(GLOBAL, param::G_COLOR_TYPE, kind as f64);
            wet.set(0, param::FILTER, 0.0);
            let a = run(&mut dry, 1.0);
            let b = run(&mut wet, 1.0);
            let worst = a
                .iter()
                .zip(&b)
                .map(|(x, y)| (x - y).abs())
                .fold(0.0, f32::max);
            assert!(
                worst < 1e-4,
                "kind {kind}: centred but changes the sound by {worst}"
            );
        }
    }
}

#[test]
fn color_filter_resonance_follows_the_parameter() {
    let peak = |param: f64| {
        let mut e = playing(noise(SR, 3.0));
        e.set(GLOBAL, param::G_COLOR_TYPE, color::FILTER as f64);
        e.set(GLOBAL, param::G_COLOR_PARAM, param);
        e.set(0, param::FILTER, -0.5);
        rms(&run(&mut e, 1.0)[24_000..])
    };
    assert!(peak(1.0) > peak(0.0) * 1.2);
}

#[test]
fn space_and_dub_echo_ring_on_after_the_knob_returns() {
    for kind in [color::SPACE, color::DUB_ECHO] {
        let mut e = playing(clicks(SR, 10.0, 0.5, 0.0));
        e.set(GLOBAL, param::G_COLOR_TYPE, kind as f64);
        e.set(GLOBAL, param::G_COLOR_PARAM, 0.8);
        e.set(0, param::FILTER, 0.9);
        run(&mut e, 2.0);
        // Centred again: the clicks no longer feed it, but what it holds rings on.
        e.set(0, param::FILTER, 0.0);
        let mut dry = playing(clicks(SR, 10.0, 0.5, 0.0));
        run(&mut dry, 2.0);
        let a = run(&mut dry, 0.3);
        let b = run(&mut e, 0.3);
        assert!(sound(&b), "kind {kind}");
        let diff = rms(&a.iter().zip(&b).map(|(x, y)| x - y).collect::<Vec<_>>());
        assert!(diff > 0.005, "kind {kind}: no tail ({diff})");
    }
}

#[test]
fn every_beat_fx_is_stable_changes_the_sound_and_lets_go() {
    let kinds = [
        fx::ECHO,
        fx::REVERB,
        fx::FLANGER,
        fx::ROLL,
        fx::DELAY,
        fx::PING_PONG,
        fx::SPIRAL,
        fx::TRANS,
        fx::FILTER,
        fx::PHASER,
        fx::PITCH,
        fx::SLIP_ROLL,
        fx::VINYL_BRAKE,
        fx::HELIX,
    ];
    for kind in kinds {
        let mut dry = playing(noise(SR, 12.0));
        let mut wet = playing(noise(SR, 12.0));
        wet.set(GLOBAL, param::G_FX_TYPE, kind as f64);
        wet.set(GLOBAL, param::G_FX_TARGET, 0.0);
        wet.set(GLOBAL, param::G_FX_BEATS, 1.0);
        wet.set(GLOBAL, param::G_FX_WET, 0.8);
        wet.set(
            GLOBAL,
            param::G_FX_PARAM,
            if kind == fx::PITCH { 1.0 } else { 0.6 },
        );
        run(&mut dry, 0.5);
        run(&mut wet, 0.5);
        wet.set(GLOBAL, param::G_FX_ON, 1.0);
        let a = run(&mut dry, 3.0);
        let b = run(&mut wet, 3.0);
        assert!(sound(&b), "fx {kind}: not finite or too loud");
        let diff = rms(&a.iter().zip(&b).map(|(x, y)| x - y).collect::<Vec<_>>());
        assert!(
            diff > 0.05 * rms(&a),
            "fx {kind}: no change ({diff} vs {})",
            rms(&a)
        );
        // Off again: the sound comes back (echo tails may ring a while).
        wet.set(GLOBAL, param::G_FX_ON, 0.0);
        run(&mut dry, 6.0);
        let tail = run(&mut wet, 6.0);
        assert!(sound(&tail), "fx {kind}: unstable after switching off");
        let a = run(&mut dry, 0.5);
        let b = run(&mut wet, 0.5);
        let diff = rms(&a.iter().zip(&b).map(|(x, y)| x - y).collect::<Vec<_>>());
        assert!(
            diff < 0.25 * rms(&a),
            "fx {kind}: still on after 6 s off ({diff})"
        );
    }
}

#[test]
fn vinyl_brake_slows_to_silence() {
    let mut e = playing(sine(SR, 10.0, 440.0));
    e.set(GLOBAL, param::G_FX_TYPE, fx::VINYL_BRAKE as f64);
    e.set(GLOBAL, param::G_FX_TARGET, 0.0);
    e.set(GLOBAL, param::G_FX_BEATS, 2.0);
    e.set(GLOBAL, param::G_FX_WET, 1.0);
    run(&mut e, 0.5);
    e.set(GLOBAL, param::G_FX_ON, 1.0);
    let first = run(&mut e, 0.3);
    // Two beats at 120 BPM: stopped after a second.
    run(&mut e, 1.0);
    let after = run(&mut e, 0.5);
    assert!(freq(&first) > 300.0, "{}", freq(&first));
    assert!(rms(&after) < 0.05, "{}", rms(&after));
}

#[test]
fn pitch_shifts_up_an_octave() {
    let mut e = playing(sine(SR, 10.0, 440.0));
    e.set(GLOBAL, param::G_FX_TYPE, fx::PITCH as f64);
    e.set(GLOBAL, param::G_FX_TARGET, 0.0);
    e.set(GLOBAL, param::G_FX_WET, 1.0);
    e.set(GLOBAL, param::G_FX_PARAM, 1.0);
    e.set(GLOBAL, param::G_FX_ON, 1.0);
    run(&mut e, 0.5);
    let f = freq(&run(&mut e, 1.0));
    assert!((f - 880.0).abs() < 60.0, "{f}");
}

#[test]
fn trans_cuts_in_time_with_the_beat() {
    let mut e = playing(sine(SR, 10.0, 440.0));
    e.set(GLOBAL, param::G_FX_TYPE, fx::TRANS as f64);
    e.set(GLOBAL, param::G_FX_TARGET, 0.0);
    e.set(GLOBAL, param::G_FX_BEATS, 0.5);
    e.set(GLOBAL, param::G_FX_WET, 1.0);
    e.set(GLOBAL, param::G_FX_PARAM, 0.5);
    e.set(GLOBAL, param::G_FX_ON, 1.0);
    run(&mut e, 0.2);
    let out = run(&mut e, 1.0);
    // Half-beat cuts at 120 BPM: 4 per second, about half the time silent.
    let silent =
        out.chunks(240).filter(|c| rms(c) < 0.01).count() as f64 / (out.len() / 240) as f64;
    assert!((0.3..0.7).contains(&silent), "{silent}");
}

#[test]
#[ignore = "timing; run with --ignored --nocapture"]
fn fx_cost() {
    let mut e = Engine::new(SR);
    for d in 0..4 {
        load(&mut e, d, sine(44_100.0, 60.0, 220.0 + 50.0 * d as f64));
        e.set(d, param::PLAY, 1.0);
    }
    let time = |e: &mut Engine| {
        let t = std::time::Instant::now();
        run(e, 20.0);
        t.elapsed().as_secs_f64() / 20.0 * 1e3
    };
    let plain = time(&mut e);
    for kind in [color::SPACE, color::DUB_ECHO, color::NOISE] {
        e.set(GLOBAL, param::G_COLOR_TYPE, kind as f64);
        for d in 0..4 {
            e.set(d, param::FILTER, 0.7);
        }
        e.set(GLOBAL, param::G_FX_TYPE, fx::SPIRAL as f64);
        e.set(GLOBAL, param::G_FX_ON, 1.0);
        println!("4 decks, colour fx {kind} on all and spiral on the master: {:.1} ms per second (plain {plain:.1})", time(&mut e));
    }
}
