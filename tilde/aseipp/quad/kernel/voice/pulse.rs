// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The desktop's sound server, through PulseAudio's simple API
//! (`libpulse-simple.so.0`): PipeWire serves it (pipewire-pulse), as
//! PulseAudio itself does. Nothing links against it: it is loaded when
//! voice starts, as Vulkan is when a window opens, so a quad that never
//! speaks never needs it. Its calls are made here alone.
//!
//! Each stream shows up in the desktop's mixer as quad's: its volume, and
//! which microphone and speakers it uses, are set there.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::OnceLock;

use super::opus::{FRAME, RATE};

/// pa_sample_spec.
#[repr(C)]
struct SampleSpec {
    format: c_int,
    rate: u32,
    channels: u8,
}

/// pa_buffer_attr: in bytes; u32::MAX leaves one to the server.
#[repr(C)]
struct BufferAttr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    fragsize: u32,
}

const PA_SAMPLE_S16LE: c_int = 3;
const PA_STREAM_PLAYBACK: c_int = 1;
const PA_STREAM_RECORD: c_int = 2;

type New = unsafe extern "C" fn(
    server: *const c_char,
    name: *const c_char,
    dir: c_int,
    dev: *const c_char,
    stream_name: *const c_char,
    ss: *const SampleSpec,
    map: *const c_void,
    attr: *const BufferAttr,
    error: *mut c_int,
) -> *mut c_void;
type Io = unsafe extern "C" fn(
    s: *mut c_void,
    data: *mut c_void,
    bytes: usize,
    error: *mut c_int,
) -> c_int;
type Free = unsafe extern "C" fn(s: *mut c_void);
type StrError = unsafe extern "C" fn(error: c_int) -> *const c_char;

/// The library's entry points.
struct Api {
    new: New,
    read: Io,
    write: Io,
    free: Free,
    strerror: StrError,
}

/// Loads the library, once; it stays loaded.
fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        // SAFETY: dlopen with a constant name; the handle is never closed,
        // so the symbols below stay valid for the process's life.
        let lib = unsafe { libc::dlopen(c"libpulse-simple.so.0".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if lib.is_null() {
            return Err("cannot load libpulse-simple.so.0: is PipeWire (pipewire-pulse) or PulseAudio installed?".into());
        }
        let sym = |name: &CStr| {
            // SAFETY: lib is a live handle; dlsym searches it and the
            // libraries it depends on (pa_strerror is libpulse's).
            let p = unsafe { libc::dlsym(lib, name.as_ptr()) };
            if p.is_null() {
                Err(format!("libpulse-simple.so.0 has no {}", name.to_string_lossy()))
            } else {
                Ok(p)
            }
        };
        // SAFETY: each symbol is the function of that name in the simple
        // API, whose C signature the type above spells.
        unsafe {
            Ok(Api {
                new: std::mem::transmute::<*mut c_void, New>(sym(c"pa_simple_new")?),
                read: std::mem::transmute::<*mut c_void, Io>(sym(c"pa_simple_read")?),
                write: std::mem::transmute::<*mut c_void, Io>(sym(c"pa_simple_write")?),
                free: std::mem::transmute::<*mut c_void, Free>(sym(c"pa_simple_free")?),
                strerror: std::mem::transmute::<*mut c_void, StrError>(sym(c"pa_strerror")?),
            })
        }
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn describe(api: &Api, error: c_int) -> String {
    // SAFETY: pa_strerror returns a static string, or null.
    let s = unsafe { (api.strerror)(error) };
    if s.is_null() {
        format!("error {error}")
    } else {
        // SAFETY: a nul-terminated static string.
        unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned()
    }
}

/// A stream to or from the sound server: mono 16-bit samples at 48 kHz.
pub struct Stream {
    s: *mut c_void,
    api: &'static Api,
    record: bool,
}

// SAFETY: a simple-API connection is used by one thread at a time (&mut
// self); it runs its own main loop inside.
unsafe impl Send for Stream {}

const FRAME_BYTES: u32 = (FRAME * 2) as u32;

impl Stream {
    /// The microphone (`record`), or the speakers, as the desktop's mixer
    /// routes quad's streams. `device` names a source or sink; None, the
    /// default.
    pub fn open(record: bool, device: Option<&str>) -> Result<Stream, String> {
        let api = api()?;
        let spec = SampleSpec {
            format: PA_SAMPLE_S16LE,
            rate: RATE as u32,
            channels: 1,
        };
        // Recording hands over a frame at a time; playing keeps three
        // frames queued (60 ms), enough to ride out a late wakeup.
        let attr = if record {
            BufferAttr {
                maxlength: u32::MAX,
                tlength: u32::MAX,
                prebuf: u32::MAX,
                minreq: u32::MAX,
                fragsize: FRAME_BYTES,
            }
        } else {
            BufferAttr {
                maxlength: u32::MAX,
                tlength: 3 * FRAME_BYTES,
                prebuf: u32::MAX,
                minreq: FRAME_BYTES,
                fragsize: u32::MAX,
            }
        };
        let device = device
            .map(|d| CString::new(d).map_err(|_| "a device name has a nul in it".to_string()))
            .transpose()?;
        let mut error = 0;
        // SAFETY: every pointer is to a live, nul-terminated string or a
        // struct of the layout the API takes, or null where it allows.
        let s = unsafe {
            (api.new)(
                std::ptr::null(),
                c"quad".as_ptr(),
                if record {
                    PA_STREAM_RECORD
                } else {
                    PA_STREAM_PLAYBACK
                },
                device.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
                c"voice".as_ptr(),
                &spec,
                std::ptr::null(),
                &attr,
                &mut error,
            )
        };
        if s.is_null() {
            return Err(format!(
                "the sound server would not open the {}: {}",
                if record { "microphone" } else { "speakers" },
                describe(api, error)
            ));
        }
        Ok(Stream { s, api, record })
    }

    /// The next frame from the microphone, waiting for it.
    pub fn read(&mut self, frame: &mut [i16; FRAME]) -> Result<(), String> {
        debug_assert!(self.record);
        let mut error = 0;
        // SAFETY: `frame` is FRAME_BYTES bytes, written in full.
        let r = unsafe {
            (self.api.read)(
                self.s,
                frame.as_mut_ptr().cast(),
                FRAME_BYTES as usize,
                &mut error,
            )
        };
        if r < 0 {
            return Err(describe(self.api, error));
        }
        Ok(())
    }

    /// Queues a frame for the speakers, waiting while the queue is full.
    pub fn write(&mut self, frame: &[i16; FRAME]) -> Result<(), String> {
        debug_assert!(!self.record);
        let mut error = 0;
        // SAFETY: `frame` is FRAME_BYTES bytes, only read (the API's
        // pointer is const; one type serves both directions here).
        let r = unsafe {
            (self.api.write)(
                self.s,
                frame.as_ptr().cast_mut().cast(),
                FRAME_BYTES as usize,
                &mut error,
            )
        };
        if r < 0 {
            return Err(describe(self.api, error));
        }
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: made by pa_simple_new, and freed once.
        unsafe { (self.api.free)(self.s) }
    }
}
