//! Prints what the analysis finds in audio files:
//! `cargo run --release -p bm-analysis --example analyse -- FILE...`

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let ext = path.rsplit('.').next().map(str::to_owned);
        let t = std::time::Instant::now();
        let d = bm_decode::decode(bytes, ext.as_deref(), true).expect("decode");
        let a = bm_analysis::analyse(&d.left, d.rate, Default::default());
        println!(
            "{path}\n  bpm {:.3}  anchor {:.4} s  grid conf {:.2}  downbeat conf {:.2}  key {:?}  ({:.2} s)",
            a.bpm,
            a.anchor_s,
            a.grid_confidence,
            a.downbeat_confidence,
            a.key.map(|k| (k.tonic, k.minor)),
            t.elapsed().as_secs_f64()
        );
    }
}
