// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Windows' sound, through WASAPI in shared mode: the audio engine mixes
//! quad's streams with everything else's, and converts to and from its
//! devices' own format and rate (AUTOCONVERTPCM). The devices are the
//! communications ones the user chose in Sound settings, or one named.
//!
//! Each stream runs on a thread of its own, which COM is initialized on
//! and every WASAPI call made from: it waits on the engine's event, and
//! hands samples to and from [`Stream`] through `shared`, as Core Audio's
//! callbacks do (coreaudio.rs).

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, PROPERTYKEY, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    DEVICE_STATE_ACTIVE, EDataFlow, IAudioCaptureClient, IAudioClient, IAudioRenderClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVE_FORMAT_PCM, WAVEFORMATEX, eCapture,
    eCommunications, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::{GUID, PCWSTR};

use super::opus::{FRAME, RATE};

/// Samples recorded that wait for a reader, at most: one that has fallen
/// further behind loses the oldest, as speech is no use late.
const MAX_RECORDED: usize = 4 * FRAME;

/// Samples queued for the speakers beyond the engine's buffer, at most: a
/// writer waits while there are this many.
const MAX_QUEUED: usize = FRAME;

/// The engine's buffer, in 100-nanosecond units: for the speakers 40 ms,
/// which with a frame queued here keeps about three frames (60 ms) ahead,
/// as pulse.rs does; for the microphone 100 ms, which a late reader has to
/// catch up in before the engine drops what it recorded.
const PLAY_BUFFER: i64 = 400_000;
const RECORD_BUFFER: i64 = 1_000_000;

/// How long a stream waits for its device before it gives up on it (taken
/// away, say).
const STALLED: Duration = Duration::from_secs(5);

/// How often the stream's thread looks to see whether it is to stop, at
/// least, when the engine says nothing.
const POLL_MS: u32 = 100;

/// PKEY_Device_FriendlyName (functiondiscoverykeys_devpkey.h): a device's
/// name, as Sound settings shows it ("Headset Microphone (Jabra ...)").
const DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

/// What a stream's thread and the stream share.
#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    /// Recorded and not yet read, or written and not yet played.
    samples: VecDeque<i16>,
    /// The stream is dropped: the thread stops.
    stop: bool,
    /// Why the device stopped, if it has.
    failed: Option<String>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A stream to or from a device: mono 16-bit samples at 48 kHz.
pub struct Stream {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
    record: bool,
}

impl Stream {
    /// The microphone (`record`), or the speakers: the communications
    /// devices Sound settings chooses, or (`device`) the one whose name has
    /// `device` in it, or whose endpoint ID it is.
    pub fn open(record: bool, device: Option<&str>) -> Result<Stream, String> {
        let shared = Arc::new(Shared::default());
        let (ready, opened) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name(
                if record {
                    "quad-voice-mic"
                } else {
                    "quad-voice-out"
                }
                .into(),
            )
            .spawn({
                let shared = shared.clone();
                let device = device.map(str::to_string);
                move || run(record, device.as_deref(), &shared, ready)
            })
            .map_err(|e| e.to_string())?;
        let what = if record { "microphone" } else { "speakers" };
        match opened.recv() {
            Ok(Ok(())) => Ok(Stream {
                shared,
                thread: Some(thread),
                record,
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(format!("Windows would not open the {what}: {e}"))
            }
            Err(_) => {
                let _ = thread.join();
                Err(format!("Windows would not open the {what}"))
            }
        }
    }

    /// The next frame from the microphone, waiting for it.
    pub fn read(&mut self, frame: &mut [i16; FRAME]) -> Result<(), String> {
        debug_assert!(self.record);
        let (mut state, waited) = self
            .shared
            .changed
            .wait_timeout_while(self.shared.lock(), STALLED, |s| {
                s.samples.len() < FRAME && s.failed.is_none()
            })
            .unwrap_or_else(|e| e.into_inner());
        if let Some(why) = &state.failed {
            return Err(why.clone());
        }
        if waited.timed_out() {
            return Err("the microphone stopped".into());
        }
        for (x, sample) in frame.iter_mut().zip(state.samples.drain(..FRAME)) {
            *x = sample;
        }
        Ok(())
    }

    /// Queues a frame for the speakers, waiting while the queue is full.
    pub fn write(&mut self, frame: &[i16; FRAME]) -> Result<(), String> {
        debug_assert!(!self.record);
        let (mut state, waited) = self
            .shared
            .changed
            .wait_timeout_while(self.shared.lock(), STALLED, |s| {
                s.samples.len() >= MAX_QUEUED && s.failed.is_none()
            })
            .unwrap_or_else(|e| e.into_inner());
        if let Some(why) = &state.failed {
            return Err(why.clone());
        }
        if waited.timed_out() {
            return Err("the speakers stopped".into());
        }
        state.samples.extend(frame);
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.shared.lock().stop = true;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A stream's thread: COM, the device, then its samples, until the stream
/// stops or the device fails. Whether it opened goes to `ready`.
fn run(
    record: bool,
    device: Option<&str>,
    shared: &Shared,
    ready: mpsc::Sender<Result<(), String>>,
) {
    // SAFETY: this thread's own COM, in the multithreaded apartment, which
    // WASAPI's objects are made in; uninitialized below, once they are
    // gone.
    if let Err(e) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        let _ = ready.send(Err(format!("COM: {e}")));
        return;
    }
    match Engine::open(record, device) {
        Ok(engine) => {
            let _ = ready.send(Ok(()));
            let served = engine.serve(shared);
            drop(engine);
            let mut state = shared.lock();
            if let Err(why) = served {
                state.failed = Some(why);
            }
            shared.changed.notify_all();
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
    // SAFETY: initialized above, on this thread; its objects are dropped.
    unsafe { CoUninitialize() };
}

/// A device's stream in the audio engine.
struct Engine {
    client: IAudioClient,
    io: Io,
    /// Signalled by the engine when there is room, or something recorded.
    event: HANDLE,
    /// The engine's buffer's size, in frames (samples, as this is mono).
    buffer: u32,
}

enum Io {
    Capture(IAudioCaptureClient),
    Render(IAudioRenderClient),
}

fn error(what: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |e| format!("{what}: {e}")
}

impl Engine {
    fn open(record: bool, name: Option<&str>) -> Result<Engine, String> {
        let flow = if record { eCapture } else { eRender };
        // SAFETY: COM is initialized on this thread (run); every pointer
        // given is to a live value of the type the call takes, and the
        // event is closed once, by Drop, after the client has stopped.
        unsafe {
            let devices: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(error("the device enumerator"))?;
            let device = match name {
                None => devices
                    .GetDefaultAudioEndpoint(flow, eCommunications)
                    .map_err(error("no device is chosen"))?,
                Some(name) => find(&devices, flow, name)?,
            };
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(error("the device's audio client"))?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_PCM as u16,
                nChannels: 1,
                nSamplesPerSec: RATE as u32,
                nAvgBytesPerSec: RATE as u32 * 2,
                nBlockAlign: 2,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    if record { RECORD_BUFFER } else { PLAY_BUFFER },
                    0,
                    &format,
                    None,
                )
                .map_err(error("the stream"))?;
            let io = if record {
                Io::Capture(client.GetService().map_err(error("capturing"))?)
            } else {
                Io::Render(client.GetService().map_err(error("rendering"))?)
            };
            let buffer = client.GetBufferSize().map_err(error("the buffer"))?;
            let event =
                CreateEventW(None, false, false, PCWSTR::null()).map_err(error("an event"))?;
            // Closes the event, from here on, whatever fails.
            let engine = Engine {
                client,
                io,
                event,
                buffer,
            };
            engine
                .client
                .SetEventHandle(engine.event)
                .map_err(error("the stream's event"))?;
            engine.client.Start().map_err(error("starting"))?;
            Ok(engine)
        }
    }

    /// Moves samples between the engine and `shared` as the engine asks,
    /// until the stream stops (Ok) or the device fails.
    fn serve(&self, shared: &Shared) -> Result<(), String> {
        let mut quiet = Duration::ZERO;
        loop {
            if shared.lock().stop {
                return Ok(());
            }
            // SAFETY: the engine's own event, open while it is.
            if unsafe { WaitForSingleObject(self.event, POLL_MS) } != WAIT_OBJECT_0 {
                quiet += Duration::from_millis(u64::from(POLL_MS));
                if quiet >= STALLED {
                    return Err("the device stopped".into());
                }
                continue;
            }
            quiet = Duration::ZERO;
            match &self.io {
                Io::Capture(capture) => self.captured(capture, shared)?,
                Io::Render(render) => self.render(render, shared)?,
            }
            shared.changed.notify_all();
        }
    }

    /// Takes every packet the engine has recorded.
    fn captured(&self, capture: &IAudioCaptureClient, shared: &Shared) -> Result<(), String> {
        // SAFETY: the engine's packets, read within their length (frames
        // of one 16-bit sample, as the stream was made) and released once.
        unsafe {
            while capture.GetNextPacketSize().map_err(error("recording"))? > 0 {
                let mut data = std::ptr::null_mut();
                let (mut frames, mut flags) = (0u32, 0u32);
                capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .map_err(error("recording"))?;
                let mut state = shared.lock();
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    state
                        .samples
                        .extend(std::iter::repeat_n(0, frames as usize));
                } else {
                    let samples = std::slice::from_raw_parts(data.cast::<i16>(), frames as usize);
                    state.samples.extend(samples);
                }
                let over = state.samples.len().saturating_sub(MAX_RECORDED);
                state.samples.drain(..over);
                drop(state);
                capture.ReleaseBuffer(frames).map_err(error("recording"))?;
            }
        }
        Ok(())
    }

    /// Fills what room the engine has with what is queued.
    fn render(&self, render: &IAudioRenderClient, shared: &Shared) -> Result<(), String> {
        // SAFETY: the engine's buffer, written within the frames asked for
        // (of one 16-bit sample) and released once.
        unsafe {
            let padding = self.client.GetCurrentPadding().map_err(error("playing"))?;
            let room = self.buffer.saturating_sub(padding) as usize;
            let mut state = shared.lock();
            let n = room.min(state.samples.len());
            if n == 0 {
                return Ok(());
            }
            let at = render
                .GetBuffer(n as u32)
                .map_err(error("playing"))?
                .cast::<i16>();
            for (i, sample) in state.samples.drain(..n).enumerate() {
                at.add(i).write_unaligned(sample);
            }
            drop(state);
            render
                .ReleaseBuffer(n as u32, 0)
                .map_err(error("playing"))?;
        }
        Ok(())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: the client made in open, and the event, closed once, after
        // the client has stopped signalling it.
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

/// The active device of `flow` whose name has `name` in it (ignoring
/// case), or whose endpoint ID is `name`.
///
/// # Safety
///
/// COM must be initialized on this thread.
unsafe fn find(
    devices: &IMMDeviceEnumerator,
    flow: EDataFlow,
    name: &str,
) -> Result<IMMDevice, String> {
    let wanted = name.to_lowercase();
    let mut seen = Vec::new();
    // SAFETY: COM is initialized (the caller's); the ID is freed once, with
    // the allocator that made it.
    unsafe {
        let all = devices
            .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
            .map_err(error("listing devices"))?;
        for i in 0..all.GetCount().map_err(error("listing devices"))? {
            let Ok(device) = all.Item(i) else { continue };
            let id = device.GetId().ok().map(|id| {
                let text = id.to_string().unwrap_or_default();
                CoTaskMemFree(Some(id.0 as *const _));
                text
            });
            let friendly = device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&DEVICE_FRIENDLY_NAME))
                .map(|v| v.to_string())
                .unwrap_or_default();
            if id.as_deref() == Some(name) || friendly.to_lowercase().contains(&wanted) {
                return Ok(device);
            }
            seen.push(friendly);
        }
    }
    Err(format!(
        "no device is named {name:?} (there are: {})",
        seen.join(", ")
    ))
}
