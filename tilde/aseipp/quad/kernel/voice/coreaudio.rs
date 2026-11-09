// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Mac's microphone and speakers, through Core Audio's audio queues
//! (AudioToolbox), as pulse.rs reaches the desktop's sound server on
//! Linux: a stream of mono 16-bit samples at 48 kHz each way, which a queue
//! converts to and from its device's own format and rate. The devices are
//! the system's default input and output, which the user chooses in System
//! Settings or from the menu bar. Its calls are made here alone.
//!
//! A queue calls back on a thread of its own: an input queue with each frame
//! it recorded, which waits here for [`Stream::read`]; an output queue for
//! each frame it is to play next, which [`Stream::write`] left here (or
//! silence, if it left none). The first time quad opens the microphone,
//! macOS asks the user whether the terminal quad was started from may use
//! it; until it may, the microphone records silence.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::opus::{FRAME, RATE};

type OsStatus = i32;
type AudioQueueRef = *mut c_void;

/// AudioStreamBasicDescription: a format of samples.
#[repr(C)]
struct StreamFormat {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

/// AudioQueueBuffer: what a queue records into or plays from.
#[repr(C)]
struct AudioQueueBuffer {
    capacity: u32,
    data: *mut c_void,
    size: u32,
    user_data: *mut c_void,
    packet_description_capacity: u32,
    packet_descriptions: *mut c_void,
    packet_description_count: u32,
}

/// kAudioFormatLinearPCM, with kAudioFormatFlagIsSignedInteger and
/// kAudioFormatFlagIsPacked: samples as they are, in the machine's (little)
/// endianness.
const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const SIGNED_INTEGER: u32 = 1 << 2;
const PACKED: u32 = 1 << 3;

type InputCallback = extern "C" fn(
    user: *mut c_void,
    queue: AudioQueueRef,
    buffer: *mut AudioQueueBuffer,
    start: *const c_void,
    packets: u32,
    descriptions: *const c_void,
);
type OutputCallback =
    extern "C" fn(user: *mut c_void, queue: AudioQueueRef, buffer: *mut AudioQueueBuffer);

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioQueueNewInput(
        format: *const StreamFormat,
        callback: InputCallback,
        user: *mut c_void,
        run_loop: *const c_void,
        run_loop_mode: *const c_void,
        flags: u32,
        queue: *mut AudioQueueRef,
    ) -> OsStatus;
    fn AudioQueueNewOutput(
        format: *const StreamFormat,
        callback: OutputCallback,
        user: *mut c_void,
        run_loop: *const c_void,
        run_loop_mode: *const c_void,
        flags: u32,
        queue: *mut AudioQueueRef,
    ) -> OsStatus;
    fn AudioQueueAllocateBuffer(
        queue: AudioQueueRef,
        bytes: u32,
        buffer: *mut *mut AudioQueueBuffer,
    ) -> OsStatus;
    fn AudioQueueEnqueueBuffer(
        queue: AudioQueueRef,
        buffer: *mut AudioQueueBuffer,
        packet_descriptions: u32,
        descriptions: *const c_void,
    ) -> OsStatus;
    fn AudioQueueStart(queue: AudioQueueRef, start: *const c_void) -> OsStatus;
    fn AudioQueueDispose(queue: AudioQueueRef, immediately: u8) -> OsStatus;
}

const FRAME_BYTES: u32 = (FRAME * 2) as u32;

/// Buffers a queue goes round: three frames (60 ms), enough to ride out a
/// late wakeup, as pulse.rs keeps queued.
const BUFFERS: usize = 3;

/// Samples recorded that wait for a reader, at most: one that has fallen
/// further behind loses the oldest, as speech is no use late.
const MAX_RECORDED: usize = 4 * FRAME;

/// How long a stream waits for its queue before it gives up on the device
/// (taken away, say).
const STALLED: Duration = Duration::from_secs(5);

/// What a queue's callbacks and its stream share: the samples between them.
#[derive(Default)]
struct Shared {
    samples: Mutex<VecDeque<i16>>,
    changed: Condvar,
}

/// A stream to or from the default device: mono 16-bit samples at 48 kHz.
pub struct Stream {
    queue: AudioQueueRef,
    /// What its queue's callbacks are given, which outlives the queue.
    shared: Arc<Shared>,
    record: bool,
}

// SAFETY: a queue may be used from any thread; its callbacks reach the
// stream's state only through `shared`, which is Sync.
unsafe impl Send for Stream {}

/// A status as Core Audio's four-character codes are spelled, where it is
/// one.
fn describe(status: OsStatus) -> String {
    let code = status.to_be_bytes();
    if code.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        format!("'{}'", String::from_utf8_lossy(&code))
    } else {
        format!("error {status}")
    }
}

impl Stream {
    /// The default microphone (`record`), or the default speakers. A
    /// `device` cannot be named: the system's default is the one the user
    /// chose.
    pub fn open(record: bool, device: Option<&str>) -> Result<Stream, String> {
        let what = if record { "microphone" } else { "speakers" };
        if device.is_some() {
            return Err(format!(
                "quad uses the system's default {what}, which System Settings chooses"
            ));
        }
        let format = StreamFormat {
            sample_rate: f64::from(RATE),
            format_id: LINEAR_PCM,
            format_flags: SIGNED_INTEGER | PACKED,
            bytes_per_packet: 2,
            frames_per_packet: 1,
            bytes_per_frame: 2,
            channels_per_frame: 1,
            bits_per_channel: 16,
            reserved: 0,
        };
        let failed = |status| format!("Core Audio would not open the {what}: {}", describe(status));
        let shared = Arc::new(Shared::default());
        let user = Arc::as_ptr(&shared).cast_mut().cast();
        let mut queue = std::ptr::null_mut();
        // SAFETY: a format of the layout the API takes, a callback of its
        // type, and the stream's shared state, which outlives the queue (see
        // Drop). With no run loop, the callbacks run on the queue's own
        // thread.
        let status = unsafe {
            if record {
                AudioQueueNewInput(
                    &format,
                    recorded,
                    user,
                    std::ptr::null(),
                    std::ptr::null(),
                    0,
                    &mut queue,
                )
            } else {
                AudioQueueNewOutput(
                    &format,
                    played,
                    user,
                    std::ptr::null(),
                    std::ptr::null(),
                    0,
                    &mut queue,
                )
            }
        };
        if status != 0 {
            return Err(failed(status));
        }
        // Disposed of, with its buffers, by Drop from here on.
        let stream = Stream {
            queue,
            shared,
            record,
        };
        for _ in 0..BUFFERS {
            let mut buffer = std::ptr::null_mut();
            // SAFETY: the stream's live queue.
            let status = unsafe { AudioQueueAllocateBuffer(queue, FRAME_BYTES, &mut buffer) };
            if status != 0 {
                return Err(failed(status));
            }
            if !record {
                // SAFETY: a buffer just allocated, of FRAME_BYTES, which is
                // the queue's but not yet in it.
                unsafe {
                    std::ptr::write_bytes((*buffer).data.cast::<u8>(), 0, FRAME_BYTES as usize);
                    (*buffer).size = FRAME_BYTES;
                }
            }
            // SAFETY: the queue's own buffer, a frame of silence to play or
            // room for a frame to record.
            let status = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, std::ptr::null()) };
            if status != 0 {
                return Err(failed(status));
            }
        }
        // SAFETY: the stream's live queue, as soon as possible.
        let status = unsafe { AudioQueueStart(queue, std::ptr::null()) };
        if status != 0 {
            return Err(failed(status));
        }
        Ok(stream)
    }

    /// The next frame from the microphone, waiting for it.
    pub fn read(&mut self, frame: &mut [i16; FRAME]) -> Result<(), String> {
        debug_assert!(self.record);
        let mut samples = self.shared.samples.lock().unwrap();
        while samples.len() < FRAME {
            let (more, waited) = self.shared.changed.wait_timeout(samples, STALLED).unwrap();
            samples = more;
            if waited.timed_out() && samples.len() < FRAME {
                return Err("the microphone records nothing".into());
            }
        }
        for (x, sample) in frame.iter_mut().zip(samples.drain(..FRAME)) {
            *x = sample;
        }
        Ok(())
    }

    /// Queues a frame for the speakers, waiting while one waits already.
    pub fn write(&mut self, frame: &[i16; FRAME]) -> Result<(), String> {
        debug_assert!(!self.record);
        let mut samples = self.shared.samples.lock().unwrap();
        while samples.len() >= FRAME {
            let (fewer, waited) = self.shared.changed.wait_timeout(samples, STALLED).unwrap();
            samples = fewer;
            if waited.timed_out() && samples.len() >= FRAME {
                return Err("the speakers play nothing".into());
            }
        }
        samples.extend(frame);
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: the stream's queue, disposed of once, and at once: no
        // callback runs once this returns, so `shared`, which they were
        // given, may go after it.
        unsafe { AudioQueueDispose(self.queue, 1) };
    }
}

/// A frame the microphone recorded: kept for [`Stream::read`], and the
/// buffer given back to record into.
extern "C" fn recorded(
    user: *mut c_void,
    queue: AudioQueueRef,
    buffer: *mut AudioQueueBuffer,
    _start: *const c_void,
    _packets: u32,
    _descriptions: *const c_void,
) {
    // SAFETY: the stream's shared state, which outlives its queue; and the
    // queue's buffer, which holds `size` bytes of samples it recorded.
    let (shared, recorded) = unsafe {
        let shared = &*user.cast::<Shared>();
        let buffer = &*buffer;
        let samples = (buffer.size as usize / 2).min(FRAME);
        let recorded = std::slice::from_raw_parts(buffer.data.cast::<i16>(), samples);
        (shared, recorded)
    };
    {
        let mut samples = shared.samples.lock().unwrap();
        samples.extend(recorded);
        let late = samples.len().saturating_sub(MAX_RECORDED);
        samples.drain(..late);
    }
    shared.changed.notify_all();
    // SAFETY: the queue's own buffer, back to record into (refused once the
    // queue is going).
    unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, std::ptr::null()) };
}

/// A frame for the speakers to play next: what [`Stream::write`] left, then
/// silence.
extern "C" fn played(user: *mut c_void, queue: AudioQueueRef, buffer: *mut AudioQueueBuffer) {
    // SAFETY: as in `recorded`; the buffer has room for a frame, and the
    // queue is done with it until it is given back, below.
    let (shared, out) = unsafe {
        let shared = &*user.cast::<Shared>();
        let buffer = &mut *buffer;
        buffer.size = FRAME_BYTES;
        let out = std::slice::from_raw_parts_mut(buffer.data.cast::<i16>(), FRAME);
        (shared, out)
    };
    {
        let mut samples = shared.samples.lock().unwrap();
        for x in out.iter_mut() {
            *x = samples.pop_front().unwrap_or(0);
        }
    }
    shared.changed.notify_all();
    // SAFETY: the queue's own buffer, filled, to play.
    unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, std::ptr::null()) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn four_character_codes_are_spelled_as_codes() {
        assert_eq!(describe(i32::from_be_bytes(*b"what")), "'what'");
        assert_eq!(describe(-50), "error -50");
    }

    /// The speakers take frames as fast as they play them, and no faster:
    /// a quarter second of silence takes about that long to write. (Where
    /// there are no speakers, nothing is checked.) The microphone is not
    /// opened, as that would ask the user for leave.
    #[test]
    fn the_speakers_take_frames_as_they_play_them() {
        let mut speakers = match Stream::open(false, None) {
            Ok(s) => s,
            Err(error) => return eprintln!("skipped: {error}"),
        };
        let start = Instant::now();
        for _ in 0..13 {
            speakers.write(&[0; FRAME]).unwrap();
        }
        // The first frames go into the queue's buffers at once; the rest
        // wait their turn, 20 ms each.
        let took = start.elapsed();
        assert!(took >= Duration::from_millis(150), "{took:?}");
        assert!(took < Duration::from_secs(2), "{took:?}");
    }
}
