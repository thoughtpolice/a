// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Voice: people attached to an editor over iroh talk to each other, as
//! they edit, once each turns it on (ext/voice.sls).
//!
//! The editor is the hub. Each client in voice sends its person's speech
//! to the editor, a frame (20 ms of Opus) per QUIC datagram on the
//! connection it already has; the editor sends each frame on, unchanged,
//! to everyone else in voice, and plays them to its own person if that
//! person is in voice too. Nothing is mixed on the way: each process that
//! plays decodes every voice it hears and sums them ([`mix`]). Datagrams
//! are not resent, which is right for speech: a frame that comes late is
//! no use, and a lost one is made up from the next ([`mix::Jitter`]).
//!
//! A datagram is [`VERSION`], the speaker (the editor numbers the clients
//! it forwards for; 0 is its own person), a 16-bit sequence number (one a
//! frame, big-endian), then the Opus packet. In silence nothing is sent.
//!
//! The microphone is open only while this process's person is in voice
//! and not muted. Sound goes through the desktop's sound server on Linux
//! (pulse.rs), and Core Audio on macOS (coreaudio.rs);
//! `QUAD_VOICE_INPUT=FILE` and `QUAD_VOICE_OUTPUT=FILE` read and write raw
//! samples (16-bit, little-endian, mono, 48 kHz) instead, in real time, for
//! tests.

#[cfg(target_os = "macos")]
mod coreaudio;
mod mix;
pub mod opus;
#[cfg(target_os = "linux")]
mod pulse;

// The system's microphone and speakers.
#[cfg(target_os = "macos")]
use coreaudio as sound;
#[cfg(target_os = "linux")]
use pulse as sound;

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chez::{Mailbox, Sender};
use iroh::endpoint::Connection;

use mix::Mixer;
use opus::{Encoder, FRAME};
use quad_mesh as mesh;

/// The datagram format's version, its first byte.
const VERSION: u8 = 1;

/// Bytes before the Opus packet.
const HEADER: usize = 4;

/// The speaker number of the editor's own person.
const HOST_SPEAKER: u8 = 0;

/// Someone who said something this recently is talking.
const TALKING: Duration = Duration::from_millis(300);

/// How often who is talking is looked at, for Scheme.
const WATCH: Duration = Duration::from_millis(100);

/// The descriptor that stands for this process's own person in
/// [`talking`].
pub const LOCAL: i32 = -1;

/// A connection in voice.
struct Link {
    conn: Connection,
    /// The number the editor forwards this link's frames under, if this
    /// process is the editor (the link is a client's); None for a
    /// client's link to its editor, whose frames are numbered already.
    speaker: Option<u8>,
    task: tokio::task::JoinHandle<()>,
}

/// This process's own person's sound, while in voice.
struct Local {
    mixer: Arc<Mutex<Mixer>>,
    playing: Arc<AtomicBool>,
    /// None while muted.
    capturing: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
struct State {
    /// By the descriptor Scheme has for the connection.
    links: HashMap<i32, Link>,
    local: Option<Local>,
    /// When each speaker last said something: links by descriptor, and
    /// this process's own person as [`LOCAL`].
    heard: HashMap<i32, Instant>,
    /// Who was talking when Scheme was last told.
    told: Vec<i32>,
    watching: bool,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}

/// Where Scheme hears that who is talking changed.
struct Events {
    tx: Sender<u8>,
    rx: Mutex<Mailbox<u8>>,
}

fn events() -> Result<&'static Events, String> {
    static EVENTS: OnceLock<Result<Events, String>> = OnceLock::new();
    EVENTS
        .get_or_init(|| {
            let (tx, rx) = Mailbox::new().map_err(|e| e.to_string())?;
            Ok(Events {
                tx,
                rx: Mutex::new(rx),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The descriptor that is readable when who is talking changes.
pub fn events_fd() -> Result<i32, String> {
    Ok(events()?.rx.lock().unwrap().fd())
}

/// Who is talking: the descriptors of links, and [`LOCAL`] for this
/// process's own person.
pub fn talking() -> Vec<i32> {
    if let Ok(e) = events() {
        e.rx.lock().unwrap().take();
    }
    let s = state().lock().unwrap();
    talking_in(&s)
}

fn talking_in(s: &State) -> Vec<i32> {
    let now = Instant::now();
    let mut who: Vec<i32> = s
        .heard
        .iter()
        .filter(|&(_, &t)| now.duration_since(t) < TALKING)
        .map(|(&fd, _)| fd)
        .collect();
    who.sort_unstable();
    who
}

/// Look at who is talking while anything is in voice, and tell Scheme
/// when that changes.
fn watch(s: &mut State) {
    if s.watching {
        return;
    }
    s.watching = true;
    let _ = std::thread::Builder::new()
        .name("quad-voice".into())
        .spawn(|| {
            loop {
                std::thread::sleep(WATCH);
                let mut s = state().lock().unwrap();
                let now = talking_in(&s);
                if now != s.told {
                    s.told = now;
                    if let Ok(e) = events() {
                        let _ = e.tx.send(0);
                    }
                }
                if s.links.is_empty() && s.local.is_none() && s.told.is_empty() {
                    s.watching = false;
                    return;
                }
            }
        });
}

/// A datagram of `speaker`'s frame `seq`.
fn datagram(speaker: u8, seq: u16, packet: &[u8]) -> Vec<u8> {
    let mut d = Vec::with_capacity(HEADER + packet.len());
    d.push(VERSION);
    d.push(speaker);
    d.extend_from_slice(&seq.to_be_bytes());
    d.extend_from_slice(packet);
    d
}

/// What a datagram says: its speaker, sequence number and packet.
fn parse(d: &[u8]) -> Option<(u8, u16, &[u8])> {
    if d.len() <= HEADER || d[0] != VERSION {
        return None;
    }
    Some((d[1], u16::from_be_bytes([d[2], d[3]]), &d[HEADER..]))
}

// MARK: Links

/// Whether `fd` is a connection over iroh: a client's of this editor, or
/// this client's to an editor.
pub fn is_link(fd: i32) -> bool {
    mesh::link(fd).is_some()
}

/// Put the connection `fd` stands for in voice: a client's, if `member`
/// (this process is the editor, and forwards what it says to everyone
/// else in voice), else this client's to its editor.
pub fn join(fd: i32, member: bool) -> Result<(), String> {
    let conn = mesh::link(fd).ok_or("not a connection over iroh")?;
    let mut s = state().lock().unwrap();
    if s.links.contains_key(&fd) {
        return Ok(());
    }
    let speaker = if member {
        let taken: HashSet<u8> = s.links.values().filter_map(|l| l.speaker).collect();
        Some(
            (1..=u8::MAX)
                .find(|n| !taken.contains(n))
                .ok_or("too many people in voice")?,
        )
    } else {
        None
    };
    let task = mesh::runtime().spawn(receive(fd, conn.clone()));
    s.links.insert(
        fd,
        Link {
            conn,
            speaker,
            task,
        },
    );
    watch(&mut s);
    Ok(())
}

/// Take the connection `fd` stands for out of voice.
pub fn leave(fd: i32) {
    let mut s = state().lock().unwrap();
    if let Some(link) = s.links.remove(&fd) {
        link.task.abort();
    }
    s.heard.remove(&fd);
    if let Some(local) = &s.local {
        local.mixer.lock().unwrap().forget_link(fd);
    }
}

/// Frames arriving on link `fd`, until it closes or leaves voice.
async fn receive(fd: i32, conn: Connection) {
    while let Ok(d) = conn.read_datagram().await {
        let Some((speaker, seq, packet)) = parse(&d) else {
            continue;
        };
        let mut s = state().lock().unwrap();
        let Some(link) = s.links.get(&fd) else {
            return;
        };
        // An editor forwards a client's frames to everyone else in voice,
        // under the number it gave that client.
        let speaker = match link.speaker {
            Some(number) => {
                let out = bytes::Bytes::from(datagram(number, seq, packet));
                for (&other, l) in &s.links {
                    if other != fd {
                        let _ = l.conn.send_datagram(out.clone());
                    }
                }
                HOST_SPEAKER
            }
            None => speaker,
        };
        s.heard.insert(fd, Instant::now());
        if let Some(local) = &s.local {
            local
                .mixer
                .lock()
                .unwrap()
                .push((fd, speaker), seq, packet.to_vec());
        }
    }
    // The connection closed.
    leave(fd);
}

// MARK: This process's own sound

/// Where this process's person's speech comes from.
enum Input {
    Device(sound::Stream),
    File {
        samples: Vec<i16>,
        at: usize,
        clock: Clock,
    },
}

/// Where what this process hears goes.
enum Output {
    Device(sound::Stream),
    File { file: std::fs::File, clock: Clock },
}

/// Real time, for files, which would otherwise read and write as fast as
/// they could.
struct Clock {
    start: Instant,
    frames: u32,
}

impl Clock {
    fn new() -> Clock {
        Clock {
            start: Instant::now(),
            frames: 0,
        }
    }

    /// Wait for the next frame's time.
    fn tick(&mut self) {
        self.frames += 1;
        let due = self.start + Duration::from_millis(20) * self.frames;
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
    }
}

impl Input {
    fn open() -> Result<Input, String> {
        match std::env::var_os("QUAD_VOICE_INPUT") {
            Some(path) => {
                let bytes =
                    std::fs::read(&path).map_err(|e| format!("{}: {e}", path.to_string_lossy()))?;
                let samples = bytes
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]))
                    .collect();
                Ok(Input::File {
                    samples,
                    at: 0,
                    clock: Clock::new(),
                })
            }
            None => Ok(Input::Device(sound::Stream::open(true, None)?)),
        }
    }

    /// The next frame, waiting for it. A file plays once, then silence.
    fn read(&mut self, frame: &mut [i16; FRAME]) -> Result<(), String> {
        match self {
            Input::Device(s) => s.read(frame),
            Input::File { samples, at, clock } => {
                clock.tick();
                for x in frame.iter_mut() {
                    *x = samples.get(*at).copied().unwrap_or(0);
                    *at += 1;
                }
                Ok(())
            }
        }
    }
}

impl Output {
    fn open() -> Result<Output, String> {
        match std::env::var_os("QUAD_VOICE_OUTPUT") {
            Some(path) => {
                let file = std::fs::File::create(&path)
                    .map_err(|e| format!("{}: {e}", path.to_string_lossy()))?;
                Ok(Output::File {
                    file,
                    clock: Clock::new(),
                })
            }
            None => Ok(Output::Device(sound::Stream::open(false, None)?)),
        }
    }

    fn write(&mut self, frame: &[i16; FRAME]) -> Result<(), String> {
        match self {
            Output::Device(s) => s.write(frame),
            Output::File { file, clock } => {
                let bytes: Vec<u8> = frame.iter().flat_map(|x| x.to_le_bytes()).collect();
                file.write_all(&bytes).map_err(|e| e.to_string())?;
                clock.tick();
                Ok(())
            }
        }
    }
}

/// This process's person's sound: "on" (hearing and speaking), "muted"
/// (hearing only: the microphone is closed) or "off".
pub fn set_local(mode: &str) -> Result<(), String> {
    let (hear, speak) = match mode {
        "on" => (true, true),
        "muted" => (true, false),
        "off" => (false, false),
        _ => return Err(format!("{mode:?}: voice is \"on\", \"muted\" or \"off\"")),
    };
    let mut s = state().lock().unwrap();
    if !hear {
        if let Some(local) = s.local.take() {
            stop(&local);
        }
        s.heard.remove(&LOCAL);
        return Ok(());
    }
    if s.local.is_none() {
        // The devices open here, so that what fails is said to whoever
        // turned voice on.
        let output = Output::open()?;
        let mixer = Arc::new(Mutex::new(Mixer::default()));
        let playing = Arc::new(AtomicBool::new(true));
        spawn("quad-voice-play", {
            let (mixer, playing) = (mixer.clone(), playing.clone());
            move || play(output, &mixer, &playing)
        })?;
        s.local = Some(Local {
            mixer,
            playing,
            capturing: None,
        });
    }
    let local = s.local.as_mut().expect("made above");
    match (&local.capturing, speak) {
        (None, true) => {
            let input = Input::open()?;
            let encoder = Encoder::new()?;
            let capturing = Arc::new(AtomicBool::new(true));
            spawn("quad-voice-speak", {
                let capturing = capturing.clone();
                move || speak_loop(input, encoder, &capturing)
            })?;
            local.capturing = Some(capturing);
        }
        (Some(c), false) => {
            c.store(false, Ordering::Relaxed);
            local.capturing = None;
            s.heard.remove(&LOCAL);
        }
        _ => {}
    }
    watch(&mut s);
    Ok(())
}

fn stop(local: &Local) {
    local.playing.store(false, Ordering::Relaxed);
    if let Some(c) = &local.capturing {
        c.store(false, Ordering::Relaxed);
    }
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .map(drop)
        .map_err(|e| e.to_string())
}

/// Play what the mixer has, a frame at a time, until stopped.
fn play(mut output: Output, mixer: &Mutex<Mixer>, playing: &AtomicBool) {
    let mut frame = [0i16; FRAME];
    while playing.load(Ordering::Relaxed) {
        mixer.lock().unwrap().pull(&mut frame);
        if output.write(&frame).is_err() {
            return;
        }
    }
}

/// The sequence number of this process's person's last frame: one count
/// for every speak_loop, so that a person who mutes and speaks again goes
/// on from where they were. Starting again from 0, what they say would be
/// older than what each listener last played, and thrown away as stale.
static SEQ: AtomicU16 = AtomicU16::new(0);

/// Send this process's person's speech to every link in voice, until
/// stopped.
fn speak_loop(mut input: Input, mut encoder: Encoder, capturing: &AtomicBool) {
    let mut frame = [0i16; FRAME];
    while capturing.load(Ordering::Relaxed) {
        if input.read(&mut frame).is_err() {
            return;
        }
        let seq = SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let Ok(Some(packet)) = encoder.encode(&frame) else {
            continue;
        };
        let out = bytes::Bytes::from(datagram(HOST_SPEAKER, seq, &packet));
        let mut s = state().lock().unwrap();
        // Muted or stopped while reading: nothing goes out.
        if !capturing.load(Ordering::Relaxed) {
            return;
        }
        s.heard.insert(LOCAL, Instant::now());
        for link in s.links.values() {
            let _ = link.conn.send_datagram(out.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datagrams_say_who_spoke_which_frame() {
        let d = datagram(7, 0xbeef, b"opus");
        assert_eq!(parse(&d), Some((7, 0xbeef, &b"opus"[..])));
        assert_eq!(parse(&d[..HEADER]), None, "no packet");
        let mut other = d.clone();
        other[0] = 2;
        assert_eq!(parse(&other), None, "another version");
    }
}
