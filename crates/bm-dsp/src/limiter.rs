//! A look-ahead peak limiter (from double-drop `dd-engine`, commit 9d3a720).

/// Ceiling (-1 dBFS) and release time.
const CEILING: f32 = 0.891;
const LOOKAHEAD_S: f64 = 0.002;
const RELEASE_S: f64 = 0.15;

/// The sound is delayed by the lookahead; the gain needed for each sample is known
/// that long before it plays, held over the lookahead and smoothed with a moving
/// average of the same length. So the gain is always down far enough by the time a
/// peak plays, yet it ramps down over the lookahead instead of jumping, which is what
/// makes a plain peak limiter distort.
#[derive(Clone, Debug)]
pub struct Limiter {
    delay: Vec<(f32, f32)>,
    delay_at: usize,
    window: MinWindow,
    held: Vec<f32>,
    held_at: usize,
    held_sum: f64,
    gain: f32,
    release: f32,
    counter: u64,
}

impl Limiter {
    pub fn new(sample_rate: f64) -> Self {
        let lookahead = ((LOOKAHEAD_S * sample_rate).round() as usize).max(1);
        Self {
            delay: vec![(0.0, 0.0); lookahead],
            delay_at: 0,
            window: MinWindow::new(lookahead + 1),
            held: vec![1.0; lookahead + 1],
            held_at: 0,
            held_sum: (lookahead + 1) as f64,
            gain: 1.0,
            release: (1.0 - (-1.0 / (RELEASE_S * sample_rate)).exp()) as f32,
            counter: 0,
        }
    }

    /// The gain applied right now (1 = not limiting).
    pub fn gain(&self) -> f32 {
        self.gain
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let peak = l.abs().max(r.abs());
        let needed = if peak > CEILING { CEILING / peak } else { 1.0 };
        let window_min = self.window.push(self.counter, needed);
        self.counter += 1;
        self.gain = (self.gain + (1.0 - self.gain) * self.release).min(window_min);

        self.held_sum += self.gain as f64 - self.held[self.held_at] as f64;
        self.held[self.held_at] = self.gain;
        self.held_at += 1;
        if self.held_at == self.held.len() {
            // Recount now and then so rounding never builds up.
            self.held_at = 0;
            self.held_sum = self.held.iter().map(|&g| g as f64).sum();
        }
        let gain = (self.held_sum / self.held.len() as f64) as f32;

        let (dl, dr) = std::mem::replace(&mut self.delay[self.delay_at], (l, r));
        self.delay_at = (self.delay_at + 1) % self.delay.len();
        (
            (dl * gain).clamp(-CEILING, CEILING),
            (dr * gain).clamp(-CEILING, CEILING),
        )
    }
}

/// Minimum of the last `len` values in O(1) per value, in a fixed-size ring.
#[derive(Clone, Debug)]
struct MinWindow {
    slots: Vec<(u64, f32)>,
    front: usize,
    count: usize,
}

impl MinWindow {
    fn new(len: usize) -> Self {
        Self {
            slots: vec![(0, 1.0); len],
            front: 0,
            count: 0,
        }
    }

    #[inline]
    fn push(&mut self, index: u64, value: f32) -> f32 {
        let len = self.slots.len();
        while self.count > 0 && self.slots[(self.front + self.count - 1) % len].1 >= value {
            self.count -= 1;
        }
        while self.count > 0 && self.slots[self.front].0 + len as u64 <= index {
            self.front = (self.front + 1) % len;
            self.count -= 1;
        }
        self.slots[(self.front + self.count) % len] = (index, value);
        self.count += 1;
        self.slots[self.front].1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_exceeds_the_ceiling() {
        let mut lim = Limiter::new(48_000.0);
        let mut max = 0.0f32;
        for i in 0..48_000 {
            let x = if i % 100 < 50 { 1.8 } else { -1.8 };
            let (l, _) = lim.process(x, x);
            max = max.max(l.abs());
        }
        assert!(max <= CEILING + 1e-6);
    }
}
