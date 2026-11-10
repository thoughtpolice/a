// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing the GUI's frames: in a window ([`Renderer`]), or into an image
//! with no window at all ([`Headless`]), for tests and snapshots. On Linux
//! and Windows with Vulkan, on a GPU or on a software renderer (Mesa's
//! lavapipe); on macOS with Metal 4.
//!
//! The same three pipelines (kernel/render/gui.slang) draw either way, with no
//! vertex buffers or descriptor sets: what they are given ([`Params`])
//! points at a frame's data by address, a buffer device address in Vulkan
//! and a GPU address in Metal. A frame ([`DrawList`]) is rectangles
//! (backgrounds and the cursor), then images (image.rs), then glyphs (font/
//! lays them out; slug.rs makes their curves), then more rectangles
//! (underlines).
//!
//! On Linux and Windows: Vulkan 1.3 with no render passes: dynamic
//! rendering, and the pipelines' push constants are the [`Params`].
//! Nothing links against Vulkan: ash loads the host's `libvulkan.so.1`
//! (Windows' `vulkan-1.dll`, which GPU drivers install) when a renderer is
//! made ([`ash::Entry::load`]). The host's driver loads into this process,
//! so on Linux the executable must run on the host's C library (`:quad`).
//! `QUAD_GUI_DEVICE=NAME` picks the device whose name has NAME in it
//! (`llvmpipe` for lavapipe); `QUAD_VULKAN_VALIDATION=1` turns on the
//! Khronos validation layer, where it is installed.
//!
//! Loading Vulkan and making a device take most of the time a window takes
//! to open (about 130 ms of 200, on NVIDIA's driver), so the device can be
//! made ahead ([`prepare`]), on another thread, while the editor starts
//! and the window is made. Pipelines take under a millisecond to make
//! (drivers keep their own shader caches), so none is cached here.
//!
//! On macOS: Metal 4 (macos.rs), drawing into a window's `CAMetalLayer`,
//! with the shaders as Metal source that Metal compiles when the device is
//! made, made ahead as Vulkan's is.
//!
//! Each API is called in one module alone (vulkan.rs, metal.rs), whose
//! types own its objects and keep the conditions its calls need; the rest
//! is safe code. The two give the same types to the code here, which is
//! both's: what a frame's buffers hold and the draws it makes of them
//! ([`Buffers::fill`]), the device made ahead, snapshots, and drawing
//! with no window (headless.rs). What is each's own is recording and
//! submitting commands, and presenting to a window (window.rs, macos.rs).

use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use winit::dpi::PhysicalSize;
use winit::window::Window;

use quad_font::slug::Atlas;
use quad_font::{GLYPH_BYTES, RECT_BYTES};
use quad_image::PICTURE_BYTES;

#[cfg(any(target_os = "linux", windows))]
use ash::vk;
#[cfg(any(target_os = "linux", windows))]
use quad_timing as timing;
#[cfg(any(target_os = "linux", windows))]
use std::ffi::CStr;
#[cfg(any(target_os = "linux", windows))]
use winit::raw_window_handle::{HasDisplayHandle, RawDisplayHandle};

#[cfg(any(target_os = "linux", windows))]
mod gpu;
mod headless;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod metal;
#[cfg(any(target_os = "linux", windows))]
mod vulkan;
#[cfg(any(target_os = "linux", windows))]
mod window;

#[cfg(any(target_os = "linux", windows))]
pub use gpu::Gpu;
#[cfg(any(target_os = "linux", windows))]
use gpu::*;
pub use headless::Headless;
#[cfg(target_os = "macos")]
pub use macos::{Gpu, Renderer, prepare};
#[cfg(target_os = "macos")]
use metal::*;
#[cfg(any(target_os = "linux", windows))]
use vulkan::*;
#[cfg(any(target_os = "linux", windows))]
pub use window::{Renderer, prepare};

/// The shaders, compiled by slangc (BUILD: `:gui.*.spv`).
#[cfg(any(target_os = "linux", windows))]
const RECT_VERTEX: &[u8] = include_bytes!("gui.rect.vert.spv");
#[cfg(any(target_os = "linux", windows))]
const RECT_FRAGMENT: &[u8] = include_bytes!("gui.rect.frag.spv");
#[cfg(any(target_os = "linux", windows))]
const GLYPH_VERTEX: &[u8] = include_bytes!("gui.glyph.vert.spv");
#[cfg(any(target_os = "linux", windows))]
const GLYPH_FRAGMENT: &[u8] = include_bytes!("gui.glyph.frag.spv");
#[cfg(any(target_os = "linux", windows))]
const IMAGE_VERTEX: &[u8] = include_bytes!("gui.image.vert.spv");
#[cfg(any(target_os = "linux", windows))]
const IMAGE_FRAGMENT: &[u8] = include_bytes!("gui.image.frag.spv");

/// The shaders, all six entry points of them, as Metal source written by
/// slangc (BUILD: `:gui.metal`), which Metal compiles as the device is made.
#[cfg(target_os = "macos")]
const SHADERS: &str = include_str!("gui.metal");

/// Frames the CPU may record while the GPU draws earlier ones.
const FRAMES_IN_FLIGHT: usize = 2;

/// How long to wait for a swapchain image before trying again later.
#[cfg(any(target_os = "linux", windows))]
const ACQUIRE_TIMEOUT_NS: u64 = 50_000_000;

/// The color format frames are drawn in, without a window: sRGB, so that
/// they blend in linear light (see kernel/render/gui.slang).
#[cfg(any(target_os = "linux", windows))]
const HEADLESS_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// What a frame draws, in order: `rects`, then `pictures` (images, from
/// `pixels`), then `glyphs`, then `decorations` (rectangles), from
/// `atlas`'s curves.
pub struct DrawList<'a> {
    pub rects: &'a [u8],
    pub pictures: &'a [u8],
    /// The pictures' pixels, in parts (the images', then the color
    /// glyphs'), each with its generation: the pictures find them end to
    /// end, and they are copied to the GPU when a generation changes.
    pub pixels: [(&'a [u32], u64); 2],
    pub glyphs: &'a [u8],
    pub decorations: &'a [u8],
    pub atlas: &'a Atlas,
    /// 0xRRGGBB, where nothing else is drawn.
    pub background: u32,
    /// A cell's size, in pixels.
    pub cell: [f32; 2],
    /// Where the grid's top left is, in pixels: the window's padding.
    pub origin: [f32; 2],
    /// The effects over the text (gui.slang's Effect, quad_fx's
    /// EFFECT_BYTES each), at their progress now.
    pub effects: &'a [u8],
}

/// What the shaders are given for each draw: `Params` in kernel/render/gui.slang,
/// Vulkan's push constants and Metal's buffer 0.
struct Params {
    rects: u64,
    glyphs: u64,
    curves: u64,
    bands: u64,
    pictures: u64,
    pixels: u64,
    cell: [f32; 2],
    viewport: [f32; 2],
    origin: [f32; 2],
    linear: u32,
    effect_count: u32,
    effects: u64,
}

impl Params {
    /// Six addresses, six floats, two u32s, and another address.
    const BYTES: usize = 6 * 8 + 6 * 4 + 2 * 4 + 8;

    fn bytes(&self) -> [u8; Self::BYTES] {
        let addresses = [
            self.rects,
            self.glyphs,
            self.curves,
            self.bands,
            self.pictures,
            self.pixels,
        ];
        let floats = self.cell.iter().chain(&self.viewport).chain(&self.origin);
        let fields = addresses
            .iter()
            .flat_map(|a| a.to_ne_bytes())
            .chain(floats.flat_map(|f| f.to_ne_bytes()))
            .chain(self.linear.to_ne_bytes())
            .chain(self.effect_count.to_ne_bytes())
            .chain(self.effects.to_ne_bytes());
        let mut out = [0; Self::BYTES];
        for (o, b) in out.iter_mut().zip(fields) {
            *o = b;
        }
        out
    }
}

/// Data a frame puts in a buffer: written into its mapped memory.
enum Data<'a> {
    Bytes(&'a [u8]),
    Words(&'a [u32]),
    Floats(&'a [f32]),
}

impl Data<'_> {
    fn len(&self) -> usize {
        match self {
            Data::Bytes(b) => b.len(),
            Data::Words(w) => w.len() * 4,
            Data::Floats(f) => f.len() * 4,
        }
    }

    fn write(&self, out: &mut [u8]) {
        match self {
            Data::Bytes(b) => out.copy_from_slice(b),
            Data::Words(w) => {
                for (o, v) in out.chunks_exact_mut(4).zip(w.iter()) {
                    o.copy_from_slice(&v.to_ne_bytes());
                }
            }
            Data::Floats(f) => {
                for (o, v) in out.chunks_exact_mut(4).zip(f.iter()) {
                    o.copy_from_slice(&v.to_ne_bytes());
                }
            }
        }
    }
}

// MARK: A frame's data

/// What a frame's draws read on the GPU, by address: buffers the frame
/// keeps, refilled each time it is drawn (the atlas's curves and bands
/// only with what was added to it, and the pictures' pixels only when they
/// change).
#[derive(Default)]
struct Buffers {
    rects: Option<HostBuffer>,
    glyphs: Option<HostBuffer>,
    decorations: Option<HostBuffer>,
    curves: Option<HostBuffer>,
    bands: Option<HostBuffer>,
    /// Which atlas `curves` and `bands` hold ([`Atlas::cleared`]), and
    /// how many of its curves and bands.
    atlas: Option<(u64, usize, usize)>,
    pictures: Option<HostBuffer>,
    pixels: Option<HostBuffer>,
    /// The generations of the parts of the pixels `pixels` holds.
    pixels_from: Option<[u64; 2]>,
    effects: Option<HostBuffer>,
}

/// The pipelines a frame draws with (kernel/render/gui.slang).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pipeline {
    Rect,
    Image,
    Glyph,
}

/// One of a frame's draws: `count` instances, of four vertices each, with
/// `pipeline`, given `params`.
struct Draw {
    pipeline: Pipeline,
    count: usize,
    params: Params,
}

/// `slot`'s buffer, made again first if it holds fewer than `len` bytes
/// (the old one dropped before the new one is made).
fn buffer_for<'s>(
    device: &Arc<Device>,
    slot: &'s mut Option<HostBuffer>,
    len: usize,
    read: bool,
) -> Result<&'s mut HostBuffer, String> {
    if slot.as_ref().is_none_or(|b| b.capacity() < len) {
        *slot = None;
        *slot = Some(HostBuffer::new(device, len, read)?);
    }
    Ok(slot.as_mut().expect("made above"))
}

/// Puts `data` in `slot`'s buffer, first making it larger if it does not
/// fit; returns the buffer's address.
fn put(device: &Arc<Device>, slot: &mut Option<HostBuffer>, data: Data) -> Result<u64, String> {
    let len = data.len();
    let buffer = buffer_for(device, slot, len, false)?;
    data.write(buffer.bytes_mut(len));
    Ok(buffer.address())
}

/// Puts `all` in `slot`'s buffer, which holds all but its `tail` already
/// if it fits: then only the tail is written.
fn put_tail(
    device: &Arc<Device>,
    slot: &mut Option<HostBuffer>,
    all: Data,
    tail: Data,
) -> Result<(), String> {
    let len = all.len();
    match slot {
        Some(buffer) if buffer.capacity() >= len => {
            tail.write(&mut buffer.bytes_mut(len)[len - tail.len()..]);
        }
        _ => {
            put(device, slot, all)?;
        }
    }
    Ok(())
}

impl Buffers {
    /// Fills the buffers with what `list` draws into a target `extent`
    /// pixels in size (width, height), in an sRGB format if `linear`;
    /// returns the frame's draws, in order: rectangles, pictures, glyphs,
    /// decorations. The GPU must be done with the frame's last commands.
    fn fill(
        &mut self,
        device: &Arc<Device>,
        list: &DrawList,
        extent: [u32; 2],
        linear: bool,
    ) -> Result<[Draw; 4], String> {
        let rects = put(device, &mut self.rects, Data::Bytes(list.rects))?;
        let glyphs = put(device, &mut self.glyphs, Data::Bytes(list.glyphs))?;
        let decorations = put(device, &mut self.decorations, Data::Bytes(list.decorations))?;
        let atlas = list.atlas;
        let (curves, bands) = (atlas.curves.len(), atlas.bands.len());
        if self.atlas != Some((atlas.cleared, curves, bands)) {
            // Between clears the atlas only grows: what was uploaded of it
            // is still there.
            let (c, b) = match self.atlas {
                Some((cleared, c, b)) if cleared == atlas.cleared && c <= curves && b <= bands => {
                    (c, b)
                }
                _ => (0, 0),
            };
            put_tail(
                device,
                &mut self.curves,
                Data::Floats(atlas.curves.as_flattened()),
                Data::Floats(atlas.curves[c..].as_flattened()),
            )?;
            put_tail(
                device,
                &mut self.bands,
                Data::Words(atlas.bands.as_flattened()),
                Data::Words(atlas.bands[b..].as_flattened()),
            )?;
            self.atlas = Some((atlas.cleared, curves, bands));
        }
        // Each buffer exists once something has been put in it.
        let curves = self.curves.as_ref().expect("put above").address();
        let bands = self.bands.as_ref().expect("put above").address();
        let pictures = put(device, &mut self.pictures, Data::Bytes(list.pictures))?;
        let [(images, image_generation), (colors, color_generation)] = list.pixels;
        if self.pixels_from != Some([image_generation, color_generation]) {
            let len = (images.len() + colors.len()) * 4;
            let out = buffer_for(device, &mut self.pixels, len, false)?.bytes_mut(len);
            let (first, second) = out.split_at_mut(images.len() * 4);
            Data::Words(images).write(first);
            Data::Words(colors).write(second);
            self.pixels_from = Some([image_generation, color_generation]);
        }
        let pixels = self.pixels.as_ref().expect("made above").address();
        let effects = put(device, &mut self.effects, Data::Bytes(list.effects))?;
        let effect_count = (list.effects.len() / quad_fx::EFFECT_BYTES) as u32;
        let viewport = [extent[0] as f32, extent[1] as f32];
        // Each draw's instances are at the start of its buffer: the
        // rectangle pipeline reads `rects`, the glyph one `glyphs`, the
        // image one `pictures`.
        let draw = |pipeline, address, count| Draw {
            pipeline,
            count,
            params: Params {
                rects: address,
                glyphs: address,
                curves,
                bands,
                pictures: address,
                pixels,
                cell: list.cell,
                viewport,
                origin: list.origin,
                linear: u32::from(linear),
                effect_count,
                effects,
            },
        };
        Ok([
            draw(Pipeline::Rect, rects, list.rects.len() / RECT_BYTES),
            draw(
                Pipeline::Image,
                pictures,
                list.pictures.len() / PICTURE_BYTES,
            ),
            draw(Pipeline::Glyph, glyphs, list.glyphs.len() / GLYPH_BYTES),
            draw(
                Pipeline::Rect,
                decorations,
                list.decorations.len() / RECT_BYTES,
            ),
        ])
    }
}

/// Whether frames drawn in `format` blend in linear light: whether it
/// encodes sRGB itself.
#[cfg(any(target_os = "linux", windows))]
fn is_srgb(format: vk::Format) -> bool {
    matches!(
        format,
        vk::Format::B8G8R8A8_SRGB | vk::Format::R8G8B8A8_SRGB
    )
}

/// An sRGB-encoded channel, made linear (the clear color of an sRGB image
/// is given linear).
fn linearize(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// 0xRRGGBB as the color an image in an sRGB format (`linear`) or a UNORM
/// one is cleared to: red, green and blue from 0 to 1.
fn clear_color(rgb: u32, linear: bool) -> [f32; 3] {
    [16, 8, 0].map(|shift| {
        let v = f32::from(((rgb >> shift) & 0xFF) as u8) / 255.0;
        if linear { linearize(v) } else { v }
    })
}

#[cfg(any(target_os = "linux", windows))]
fn vk_error(what: &str) -> impl Fn(vk::Result) -> String + '_ {
    move |e| format!("vulkan: {what}: {e}")
}

// MARK: Made ahead

/// What a device was made ahead for: on Linux and Windows, windows on one
/// kind of display, whose surfaces this extension makes; on macOS, any
/// window.
#[cfg(any(target_os = "linux", windows))]
type MadeFor = &'static CStr;
#[cfg(target_os = "macos")]
type MadeFor = ();

/// The device being made ahead of the first window (each platform's
/// `prepare`), and what for.
static PREPARED: Mutex<Option<(MadeFor, JoinHandle<Result<Gpu, String>>)>> = Mutex::new(None);

/// Starts making a device with `make`, on another thread, for windows of
/// `made_for`, unless one is made or being made.
fn make_ahead(made_for: MadeFor, make: impl FnOnce() -> Result<Gpu, String> + Send + 'static) {
    let mut prepared = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
    if prepared.is_some() {
        return;
    }
    let made = std::thread::Builder::new()
        .name("quad-gpu".into())
        .spawn(make);
    if let Ok(handle) = made {
        *prepared = Some((made_for, handle));
    }
}

/// The device made ahead, waited for, and what it was made for, if one
/// was made.
fn take_prepared() -> Option<(MadeFor, Gpu)> {
    let (made_for, made) = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    Some((made_for, made.join().ok()?.ok()?))
}

/// Waits for the device being made ahead, if one is, before the process
/// exits (kernel.c calls this): an exit must not race a driver still
/// loading, as NVIDIA's takes a lock as it loads that exiting takes too, and
/// the two deadlock.
#[unsafe(no_mangle)]
pub extern "C" fn quad_gui_settle() {
    let made = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((_, handle)) = made {
        // The process is ending: the device goes with it.
        if let Ok(Ok(gpu)) = handle.join() {
            std::mem::forget(gpu);
        }
    }
}

// MARK: Snapshots

/// With `QUAD_GUI_SNAPSHOT=FILE`, each frame a window presents is also
/// written to FILE, as a PPM image: what the window shows. A frame is
/// copied into [`Snapshot::buffer`] as it is drawn, then written.
struct Snapshot {
    path: std::path::PathBuf,
    buffer: Option<HostBuffer>,
}

impl Snapshot {
    fn from_env() -> Option<Snapshot> {
        let path = std::env::var_os("QUAD_GUI_SNAPSHOT")?;
        Some(Snapshot {
            path: path.into(),
            buffer: None,
        })
    }

    /// Where the next frame is to be copied, once there is a buffer for it.
    fn buffer(&mut self) -> Option<&mut HostBuffer> {
        self.buffer.as_mut()
    }

    /// Writes the frame just drawn, `extent` pixels (in BGRA order if
    /// `bgra`, else RGBA), from the buffer it was copied into; false where
    /// there was none of its size, and it was not: one is made for the next
    /// frame.
    fn write(
        &mut self,
        device: &Arc<Device>,
        extent: [u32; 2],
        bgra: bool,
    ) -> Result<bool, String> {
        let bytes = extent[0] as usize * extent[1] as usize * 4;
        if let Some(buffer) = self.buffer.as_ref().filter(|b| b.capacity() >= bytes) {
            write_ppm(&self.path, extent, buffer.read(bytes)?, bgra)?;
            return Ok(true);
        }
        buffer_for(device, &mut self.buffer, bytes, true)?;
        Ok(false)
    }
}

/// Writes RGBA (or BGRA) pixels, `width` by `height`, as a PPM image.
fn write_ppm(
    path: &std::path::Path,
    [width, height]: [u32; 2],
    pixels: &[u8],
    bgra: bool,
) -> Result<(), String> {
    let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
    ppm.reserve(pixels.len() / 4 * 3);
    for p in pixels.chunks_exact(4) {
        ppm.extend_from_slice(&if bgra {
            [p[2], p[1], p[0]]
        } else {
            [p[0], p[1], p[2]]
        });
    }
    std::fs::write(path, ppm).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_are_laid_out_as_the_shaders_read_them() {
        let params = Params {
            rects: 1,
            glyphs: 2,
            curves: 3,
            bands: 4,
            pictures: 5,
            pixels: 6,
            cell: [7.0, 8.0],
            viewport: [9.0, 10.0],
            origin: [11.0, 12.0],
            linear: 1,
            effect_count: 2,
            effects: 13,
        };
        let bytes = params.bytes();
        assert_eq!(bytes.len(), Params::BYTES);
        assert_eq!(bytes.len(), 88);
        assert_eq!(u32::from_ne_bytes(bytes[76..80].try_into().unwrap()), 2);
        assert_eq!(u64::from_ne_bytes(bytes[80..88].try_into().unwrap()), 13);
        let word = |at: usize| u64::from_ne_bytes(bytes[at..at + 8].try_into().unwrap());
        assert_eq!((word(0), word(40)), (1, 6));
        let float = |at: usize| f32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!((float(48), float(68)), (7.0, 12.0));
        assert_eq!(u32::from_ne_bytes(bytes[72..76].try_into().unwrap()), 1);
    }

    #[test]
    fn clear_colors_are_linear_for_srgb_images() {
        assert_eq!(clear_color(0xff8000, false), [1.0, 128.0 / 255.0, 0.0]);
        let [r, g, b] = clear_color(0xff8000, true);
        assert_eq!((r, b), (1.0, 0.0));
        assert!((g - 0.2158605).abs() < 1e-6);
    }
}
