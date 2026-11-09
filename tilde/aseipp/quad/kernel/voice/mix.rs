// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What this process plays: every voice it hears, each put back in order
//! by its own jitter buffer, decoded, and summed.
//!
//! Datagrams arrive late, out of order, or not at all. Each voice's
//! frames wait in a [`Jitter`] buffer until a couple are in hand, then
//! play one per frame period; a lost frame is made up from the next one's
//! redundancy when that has arrived, else concealed; once a voice has sent
//! nothing for a while (it went quiet: senders send nothing in silence),
//! it stops until it speaks again. The buffer never holds more than a few
//! frames' worth: a sender whose clock runs fast fills it, and the oldest
//! frames are dropped, so a voice is never far behind.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use super::opus::{Decoder, FRAME, Input};

/// Frames a voice has in hand before it starts playing: 40 ms.
const PREBUFFER: usize = 2;

/// Frames a voice may have waiting before the oldest are dropped.
const MAX_DEPTH: usize = 6;

/// How far ahead of the frame playing next a packet may be before the
/// voice is taken to have started again (say its sender reconnected).
const MAX_AHEAD: i16 = 50;

/// A voice that has said nothing for this long is forgotten.
const FORGET: Duration = Duration::from_secs(30);

/// What a voice plays for one frame period.
#[derive(Debug, PartialEq, Eq)]
pub enum Play {
    /// Nothing: it is quiet, or still filling its buffer.
    Silent,
    /// The frame's packet.
    Packet(Vec<u8>),
    /// The frame was lost; this is the next frame's packet, whose
    /// redundancy has a copy of it.
    Recovered(Vec<u8>),
    /// The frame was lost, and nothing came after it yet.
    Lost,
}

/// One voice's frames, by sequence number, as they play.
#[derive(Default)]
pub struct Jitter {
    /// The frame playing next, and those after it: None where it has not
    /// arrived. Empty with `next` None while the voice is quiet.
    slots: VecDeque<Option<Vec<u8>>>,
    /// The sequence number of `slots[0]`.
    next: Option<u16>,
    /// Whether enough frames came in to play.
    playing: bool,
    /// Frame periods since a packet played.
    missing: u32,
    /// The last frame played: one older that arrives once the voice went
    /// quiet is stale, not the start of something new.
    last: Option<u16>,
}

impl Jitter {
    /// A packet arrived: frame `seq`.
    pub fn push(&mut self, seq: u16, packet: Vec<u8>) {
        let Some(next) = self.next else {
            if self
                .last
                .is_some_and(|last| seq.wrapping_sub(last) as i16 <= 0)
            {
                return;
            }
            return self.restart(seq, packet);
        };
        let ahead = seq.wrapping_sub(next) as i16;
        if ahead < 0 {
            // Too late: its time has passed.
            return;
        }
        if ahead >= MAX_AHEAD {
            return self.restart(seq, packet);
        }
        let i = ahead as usize;
        if self.slots.len() <= i {
            self.slots.resize(i + 1, None);
        }
        self.slots[i] = Some(packet);
    }

    fn restart(&mut self, seq: u16, packet: Vec<u8>) {
        *self = Jitter {
            slots: VecDeque::from([Some(packet)]),
            next: Some(seq),
            last: self.last,
            ..Jitter::default()
        };
    }

    /// Quiet: nothing plays until the voice says something new.
    fn stop(&mut self) {
        *self = Jitter {
            last: self.last,
            ..Jitter::default()
        };
    }

    /// What plays for the next frame period.
    pub fn pop(&mut self) -> Play {
        let Some(mut next) = self.next else {
            return Play::Silent;
        };
        if !self.playing {
            if self.slots.len() < PREBUFFER {
                return Play::Silent;
            }
            self.playing = true;
        }
        while self.slots.len() > MAX_DEPTH {
            self.slots.pop_front();
            next = next.wrapping_add(1);
        }
        let slot = self.slots.pop_front().flatten();
        self.next = Some(next.wrapping_add(1));
        match slot {
            Some(packet) => {
                self.missing = 0;
                self.last = Some(next);
                Play::Packet(packet)
            }
            // A packet always ends the slots, so with none left, nothing
            // after this frame has arrived: one frame is concealed, then
            // the voice has gone quiet (senders send nothing in silence).
            None if self.slots.is_empty() => {
                self.missing += 1;
                if self.missing > 1 {
                    self.stop();
                    return Play::Silent;
                }
                Play::Lost
            }
            None => {
                self.missing += 1;
                match self.slots.front() {
                    Some(Some(after)) => Play::Recovered(after.clone()),
                    _ => Play::Lost,
                }
            }
        }
    }
}

/// A voice this process hears.
struct Voice {
    jitter: Jitter,
    decoder: Decoder,
    heard: Instant,
}

/// Every voice this process hears, by who sent it: the link it came on
/// and the speaker the editor numbered it with.
#[derive(Default)]
pub struct Mixer {
    voices: HashMap<(i32, u8), Voice>,
}

impl Mixer {
    /// A packet of `voice`'s frame `seq`.
    pub fn push(&mut self, voice: (i32, u8), seq: u16, packet: Vec<u8>) {
        let entry = match self.voices.entry(voice) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => match Decoder::new() {
                Ok(decoder) => e.insert(Voice {
                    jitter: Jitter::default(),
                    decoder,
                    heard: Instant::now(),
                }),
                Err(_) => return,
            },
        };
        entry.heard = Instant::now();
        entry.jitter.push(seq, packet);
    }

    /// The next frame period's samples: every voice, summed.
    pub fn pull(&mut self, out: &mut [i16; FRAME]) {
        let mut sum = [0i32; FRAME];
        let mut frame = [0i16; FRAME];
        let now = Instant::now();
        self.voices
            .retain(|_, v| now.duration_since(v.heard) < FORGET);
        for voice in self.voices.values_mut() {
            let play = voice.jitter.pop();
            let input = match &play {
                Play::Silent => continue,
                Play::Packet(p) => Input::Packet(p),
                Play::Recovered(p) => Input::Recovered(p),
                Play::Lost => Input::Lost,
            };
            voice.decoder.decode(input, &mut frame);
            for (s, &x) in sum.iter_mut().zip(frame.iter()) {
                *s += i32::from(x);
            }
        }
        for (o, s) in out.iter_mut().zip(sum) {
            *o = s.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        }
    }

    /// Forget the voices that came on `link`.
    pub fn forget_link(&mut self, link: i32) {
        self.voices.retain(|&(l, _), _| l != link);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn packet(seq: u16) -> Vec<u8> {
        seq.to_be_bytes().to_vec()
    }

    fn seq_of(p: &[u8]) -> u16 {
        u16::from_be_bytes([p[0], p[1]])
    }

    #[test]
    fn frames_play_in_order_after_a_short_wait() {
        let mut j = Jitter::default();
        assert_eq!(j.pop(), Play::Silent);
        j.push(7, packet(7));
        assert_eq!(j.pop(), Play::Silent, "one frame is not enough to start");
        j.push(9, packet(9));
        j.push(8, packet(8));
        assert_eq!(j.pop(), Play::Packet(packet(7)));
        assert_eq!(j.pop(), Play::Packet(packet(8)));
        assert_eq!(j.pop(), Play::Packet(packet(9)));
    }

    #[test]
    fn a_lost_frame_is_recovered_from_the_next() {
        let mut j = Jitter::default();
        for seq in [100, 102, 103] {
            j.push(seq, packet(seq));
        }
        assert_eq!(j.pop(), Play::Packet(packet(100)));
        assert_eq!(j.pop(), Play::Recovered(packet(102)));
        assert_eq!(j.pop(), Play::Packet(packet(102)));
    }

    #[test]
    fn a_voice_that_goes_quiet_stops_and_starts_again() {
        let mut j = Jitter::default();
        for seq in [65534, 65535, 0] {
            j.push(seq, packet(seq));
        }
        for seq in [65534, 65535, 0] {
            assert_eq!(j.pop(), Play::Packet(packet(seq)));
        }
        assert_eq!(j.pop(), Play::Lost);
        assert_eq!(j.pop(), Play::Silent);
        assert_eq!(j.pop(), Play::Silent);
        // A straggler from before is stale.
        j.push(65535, packet(65535));
        j.push(65533, packet(65533));
        assert_eq!(j.pop(), Play::Silent);
        // It speaks again, from wherever its sequence is now.
        j.push(500, packet(500));
        j.push(501, packet(501));
        assert_eq!(j.pop(), Play::Packet(packet(500)));
    }

    /// Whatever order packets arrive in, and whichever are lost, what
    /// plays is in sequence order, each packet at most once, and the
    /// buffer stays short.
    #[hegel::test(test_cases = 300, database = None)]
    fn what_plays_is_in_order_and_bounded(tc: TestCase) {
        let start = tc.draw(gs::integers::<u16>());
        let n = tc.draw(gs::integers::<u16>().min_value(1).max_value(80));
        let mut j = Jitter::default();
        let mut pending: Vec<u16> = Vec::new();
        let mut played: Vec<u16> = Vec::new();
        for i in 0..n {
            let seq = start.wrapping_add(i);
            if !tc.draw(gs::booleans()) || i == 0 {
                pending.push(seq);
            }
            // Deliver some of what is in flight, in any order.
            while !pending.is_empty() && tc.draw(gs::booleans()) {
                let k = tc.draw(gs::integers::<usize>().max_value(pending.len() - 1));
                let seq = pending.swap_remove(k);
                j.push(seq, packet(seq));
            }
            if let Play::Packet(p) = j.pop() {
                played.push(seq_of(&p));
            }
            assert!(j.slots.len() <= MAX_AHEAD as usize);
        }
        let offsets: Vec<u16> = played.iter().map(|s| s.wrapping_sub(start)).collect();
        assert!(
            offsets.windows(2).all(|w| w[0] < w[1]),
            "played out of order: {offsets:?}"
        );
    }
}
