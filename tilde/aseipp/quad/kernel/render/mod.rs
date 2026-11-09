// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing the GUI's frames with Vulkan: in a window ([`Renderer`]), or
//! into an image with no window at all ([`Headless`]), for tests and
//! snapshots, on a GPU or on a software renderer (Mesa's lavapipe).
//!
//! Vulkan 1.3 with no render passes, descriptor sets or vertex buffers:
//! dynamic rendering, and three pipelines (kernel/gui.slang) whose push
//! constants point at a frame's data by buffer device address. A frame
//! ([`DrawList`]) is rectangles (backgrounds and the cursor), then images
//! (image.rs), then glyphs (font/ lays them out; slug.rs makes their
//! curves), then more rectangles (underlines).
//!
//! Nothing links against Vulkan: ash loads the host's `libvulkan.so.1` when
//! a renderer is made ([`ash::Entry::load`]). The host's driver loads into
//! this process, so the executable must run on the host's C library
//! (`:quad-host`). `QUAD_GUI_DEVICE=NAME` picks the device whose name has
//! NAME in it (`llvmpipe` for lavapipe); `QUAD_VULKAN_VALIDATION=1` turns
//! on the Khronos validation layer, where it is installed.
//!
//! Loading Vulkan and making a device take most of the time a window takes
//! to open (about 130 ms of 200, on NVIDIA's driver), so the device can be
//! made ahead ([`prepare`]), on another thread, while the editor starts
//! and the window is made. Pipelines take under a millisecond to make
//! (drivers keep their own shader caches), so none is cached here.

use std::ffi::{CStr, c_char};
use std::rc::Rc;
use std::sync::Mutex;
use std::thread::JoinHandle;

use ash::vk;
use winit::dpi::PhysicalSize;
use winit::raw_window_handle::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use winit::window::Window;

use crate::font::{GLYPH_BYTES, RECT_BYTES};
use crate::image::PICTURE_BYTES;
use crate::slug::Atlas;
use crate::timing;

mod gpu;
mod headless;
mod window;

pub use gpu::Gpu;
use gpu::*;
pub use headless::{Headless, write_ppm};
pub use window::{Renderer, prepare};

/// The shaders, compiled by slangc (BUILD: `:gui.*.spv`).
const RECT_VERTEX: &[u8] = include_bytes!("gui.rect.vert.spv");
const RECT_FRAGMENT: &[u8] = include_bytes!("gui.rect.frag.spv");
const GLYPH_VERTEX: &[u8] = include_bytes!("gui.glyph.vert.spv");
const GLYPH_FRAGMENT: &[u8] = include_bytes!("gui.glyph.frag.spv");
const IMAGE_VERTEX: &[u8] = include_bytes!("gui.image.vert.spv");
const IMAGE_FRAGMENT: &[u8] = include_bytes!("gui.image.frag.spv");

/// Frames the CPU may record while the GPU draws earlier ones.
const FRAMES_IN_FLIGHT: usize = 2;

/// How long to wait for a swapchain image before trying again later.
const ACQUIRE_TIMEOUT_NS: u64 = 50_000_000;

/// The color format frames are drawn in, without a window: sRGB, so that
/// they blend in linear light (see kernel/gui.slang).
const HEADLESS_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// What a frame draws, in order: `rects`, then `pictures` (images, from
/// `pixels`), then `glyphs`, then `decorations` (rectangles), from
/// `atlas`'s curves.
pub struct DrawList<'a> {
    pub rects: &'a [u8],
    pub pictures: &'a [u8],
    /// The pictures' pixels, and their generation: they are copied to the
    /// GPU when it changes.
    pub pixels: (&'a [u32], u64),
    pub glyphs: &'a [u8],
    pub decorations: &'a [u8],
    pub atlas: &'a Atlas,
    /// 0xRRGGBB, where nothing else is drawn.
    pub background: u32,
    /// A cell's size, in pixels.
    pub cell: [f32; 2],
    /// Where the grid's top left is, in pixels: the window's padding.
    pub origin: [f32; 2],
}

/// What the shaders' push constants hold: `Params` in kernel/gui.slang.
#[repr(C)]
struct Params {
    rects: vk::DeviceAddress,
    glyphs: vk::DeviceAddress,
    curves: vk::DeviceAddress,
    bands: vk::DeviceAddress,
    pictures: vk::DeviceAddress,
    pixels: vk::DeviceAddress,
    cell: [f32; 2],
    viewport: [f32; 2],
    origin: [f32; 2],
    linear: u32,
    reserved: u32,
}

/// Whether frames drawn in `format` blend in linear light: whether it
/// encodes sRGB itself.
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

fn vk_error(what: &str) -> impl Fn(vk::Result) -> String + '_ {
    move |e| format!("vulkan: {what}: {e}")
}

fn bytes_of<T>(items: &[T]) -> &[u8] {
    // SAFETY: plain data (f32s and u32s), read as the bytes it is.
    unsafe { std::slice::from_raw_parts(items.as_ptr().cast(), size_of_val(items)) }
}
