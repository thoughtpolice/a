// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Metal 4's objects, owned: the one place the renderer calls Metal, and so
//! the one place it is `unsafe`, as vulkan.rs is on Linux. Everything
//! outside this module is safe code over these types.
//!
//! Metal counts references to its objects itself, and frees each once the
//! last goes; as Vulkan's do, each type here holds the [`Device`] it was
//! made on, and a window's [`Layer`] holds the window. What Metal 4 does
//! not do is what Vulkan does not either: track what the GPU uses. Its
//! command buffers keep nothing they use alive or resident, and it orders
//! one pass after another only when asked. So a buffer the CPU writes
//! ([`HostBuffer`]) is written only by a [`Frame`] whose earlier commands
//! are done (the device's event has passed their submission), and read only
//! once everything submitted is; what the GPU may still use is let go only
//! once it is done (each owner waits for the device first); every buffer
//! and image is in the device's residency set while it lives, and a
//! window's drawables are in its layer's, which the queue holds; and a
//! frame that copies what it drew waits for the drawing first (a barrier).
//! [`Target`]s are made only here, from images and drawables that outlive
//! them. With those, each call's validity follows from the types, which is
//! what each `SAFETY` note says.

use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::NSView;
use objc2_core_foundation::CGSize;
use objc2_core_graphics::{CGColorSpace, kCGColorSpaceSRGB};
use objc2_foundation::{NSError, NSString};
use objc2_metal::{
    MTL4ArgumentTable, MTL4ArgumentTableDescriptor, MTL4BlendState, MTL4CommandAllocator,
    MTL4CommandBuffer, MTL4CommandEncoder, MTL4CommandQueue, MTL4Compiler, MTL4CompilerDescriptor,
    MTL4ComputeCommandEncoder, MTL4LibraryDescriptor, MTL4LibraryFunctionDescriptor,
    MTL4RenderCommandEncoder, MTL4RenderPassDescriptor, MTL4RenderPipelineDescriptor,
    MTL4VisibilityOptions, MTLAllocation, MTLBlendFactor, MTLBlendOperation, MTLBuffer,
    MTLClearColor, MTLColorWriteMask, MTLCompileOptions, MTLCopyAllDevices,
    MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable, MTLGPUFamily, MTLLibrary, MTLLoadAction,
    MTLMathMode, MTLOrigin, MTLPixelFormat, MTLPrimitiveTopologyClass, MTLPrimitiveType,
    MTLRenderPipelineState, MTLRenderStages, MTLResidencySet, MTLResidencySetDescriptor,
    MTLResourceOptions, MTLSharedEvent, MTLSize, MTLStages, MTLStorageMode, MTLStoreAction,
    MTLTexture, MTLTextureDescriptor, MTLTextureUsage, MTLViewport,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

use super::{Data, DrawList, GLYPH_BYTES, PICTURE_BYTES, Params, RECT_BYTES, SHADERS, clear_color};
use crate::timing;

fn ns_error(what: &str) -> impl Fn(Retained<NSError>) -> String + '_ {
    move |e| format!("metal: {what}: {}", e.localizedDescription())
}

// MARK: The device

/// The objects of a residency set: a residency set is bound to no thread,
/// as AppKit's objects are to the main one, so it may move to another.
struct Residency(Retained<ProtocolObject<dyn MTLResidencySet>>);

// SAFETY: a residency set is not tied to the thread that made it, only to
// its device; the device keeps it behind a mutex, so that no two threads
// use it at once.
unsafe impl Send for Residency {}

/// A device with Metal 4, with the queue that draws, the shaders compiled
/// for it, and what says how far the GPU has got through the queue.
pub(super) struct Device {
    raw: Retained<ProtocolObject<dyn MTLDevice>>,
    queue: Retained<ProtocolObject<dyn MTL4CommandQueue>>,
    compiler: Retained<ProtocolObject<dyn MTL4Compiler>>,
    library: Retained<ProtocolObject<dyn MTLLibrary>>,
    /// Every buffer and image made on the device while it lives: what the
    /// queue's commands may use.
    residency: Mutex<Residency>,
    /// Signaled with each submission's number once the GPU is done with it.
    event: Retained<ProtocolObject<dyn MTLSharedEvent>>,
    /// The number of the last submission.
    submitted: AtomicU64,
}

impl Device {
    /// The device `QUAD_GUI_DEVICE` names (by part of its name), else the
    /// system's default one: either way, one with Metal 4. Its queue holds
    /// its residency set, and the shaders are compiled for it.
    pub(super) fn new() -> Result<Arc<Device>, String> {
        let raw = pick_device()?;
        timing::mark("metal device found");
        let queue = raw
            .newMTL4CommandQueue()
            .ok_or("metal: cannot make a command queue")?;
        let residency = raw
            .newResidencySetWithDescriptor_error(&MTLResidencySetDescriptor::new())
            .map_err(ns_error("making a residency set"))?;
        queue.addResidencySet(&residency);
        let event = raw.newSharedEvent().ok_or("metal: cannot make an event")?;
        let compiler = raw
            .newCompilerWithDescriptor_error(&MTL4CompilerDescriptor::new())
            .map_err(ns_error("making a compiler"))?;
        let library = compile_shaders(&compiler)?;
        timing::mark("shaders compiled");
        Ok(Arc::new(Device {
            raw,
            queue,
            compiler,
            library,
            residency: Mutex::new(Residency(residency)),
            event,
            submitted: AtomicU64::new(0),
        }))
    }

    pub(super) fn name(&self) -> String {
        self.raw.name().to_string()
    }

    /// Waits until the GPU is done with submission `number` (0: none).
    fn wait_for(&self, number: u64) -> Result<(), String> {
        if number == 0
            || self
                .event
                .waitUntilSignaledValue_timeoutMS(number, u64::MAX)
        {
            Ok(())
        } else {
            Err("metal: the GPU did not finish".into())
        }
    }

    /// Waits until the GPU has done everything it was given.
    pub(super) fn wait_idle(&self) -> Result<(), String> {
        self.wait_for(self.submitted.load(Ordering::Acquire))
    }

    /// Makes `allocation` resident (or no longer), for the queue's
    /// commands from now on.
    fn set_resident(&self, allocation: &ProtocolObject<dyn MTLAllocation>, resident: bool) {
        let set = self.residency.lock().unwrap_or_else(|e| e.into_inner());
        if resident {
            set.0.addAllocation(allocation);
        } else {
            set.0.removeAllocation(allocation);
        }
        set.0.commit();
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        // What the GPU was given finishes before what it uses goes.
        let _ = self.wait_idle();
    }
}

/// The device to draw with, as [`Device::new`] says.
fn pick_device() -> Result<Retained<ProtocolObject<dyn MTLDevice>>, String> {
    let wanted = std::env::var("QUAD_GUI_DEVICE")
        .ok()
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase());
    let mut seen: Vec<String> = Vec::new();
    // The default (the built-in GPU on a laptop with two) first.
    for device in MTLCreateSystemDefaultDevice()
        .into_iter()
        .chain(MTLCopyAllDevices().to_vec())
    {
        let name = device.name().to_string();
        let named = wanted
            .as_ref()
            .is_none_or(|w| name.to_lowercase().contains(w));
        if named && device.supportsFamily(MTLGPUFamily::Metal4) {
            return Ok(device);
        }
        if !seen.contains(&name) {
            seen.push(name);
        }
    }
    Err(format!(
        "no Metal 4 device {}can draw (devices: {})",
        wanted.map_or(String::new(), |w| format!("named like {w:?} ")),
        if seen.is_empty() {
            "none".into()
        } else {
            seen.join(", ")
        }
    ))
}

/// The shaders' library, compiled from their Metal source. In IEEE
/// arithmetic, as SPIR-V's is, not Metal's default fast math, which may
/// assume no infinities: Slug's root finding meets some.
fn compile_shaders(
    compiler: &ProtocolObject<dyn MTL4Compiler>,
) -> Result<Retained<ProtocolObject<dyn MTLLibrary>>, String> {
    let options = MTLCompileOptions::new();
    options.setMathMode(MTLMathMode::Safe);
    let descriptor = MTL4LibraryDescriptor::new();
    descriptor.setSource(Some(&NSString::from_str(SHADERS)));
    descriptor.setName(Some(&NSString::from_str("quad-gui")));
    descriptor.setOptions(Some(&options));
    compiler
        .newLibraryWithDescriptor_error(&descriptor)
        .map_err(ns_error("compiling the shaders"))
}

// MARK: Pipelines

/// The three pipelines (kernel/gui.slang), drawing in `format`: four-vertex
/// strips, blending by alpha over what was drawn before, their data found
/// by address in buffer 0 of their argument table ([`Params`]).
pub(super) struct Pipelines {
    device: Arc<Device>,
    pub(super) format: MTLPixelFormat,
    rect: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    glyph: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
    image: Retained<ProtocolObject<dyn MTLRenderPipelineState>>,
}

impl Pipelines {
    pub(super) fn new(device: &Arc<Device>, format: MTLPixelFormat) -> Result<Pipelines, String> {
        let pipeline = |vertex: &str, fragment: &str| pipeline(device, format, vertex, fragment);
        let pipelines = Pipelines {
            device: device.clone(),
            format,
            rect: pipeline("rectVertex", "rectFragment")?,
            glyph: pipeline("glyphVertex", "glyphFragment")?,
            image: pipeline("imageVertex", "imageFragment")?,
        };
        timing::mark("pipelines made");
        Ok(pipelines)
    }
}

/// The shaders' function `name`.
fn function(device: &Device, name: &str) -> Retained<MTL4LibraryFunctionDescriptor> {
    let function = MTL4LibraryFunctionDescriptor::new();
    function.setName(Some(&NSString::from_str(name)));
    function.setLibrary(Some(&device.library));
    function
}

fn pipeline(
    device: &Device,
    format: MTLPixelFormat,
    vertex: &str,
    fragment: &str,
) -> Result<Retained<ProtocolObject<dyn MTLRenderPipelineState>>, String> {
    let descriptor = MTL4RenderPipelineDescriptor::new();
    descriptor.setVertexFunctionDescriptor(Some(&function(device, vertex)));
    descriptor.setFragmentFunctionDescriptor(Some(&function(device, fragment)));
    descriptor.setInputPrimitiveTopology(MTLPrimitiveTopologyClass::Triangle);
    // SAFETY: the first of the pipeline's color attachments, of which it
    // has eight.
    let color = unsafe { descriptor.colorAttachments().objectAtIndexedSubscript(0) };
    color.setPixelFormat(format);
    color.setBlendingState(MTL4BlendState::Enabled);
    color.setSourceRGBBlendFactor(MTLBlendFactor::SourceAlpha);
    color.setDestinationRGBBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
    color.setRgbBlendOperation(MTLBlendOperation::Add);
    color.setSourceAlphaBlendFactor(MTLBlendFactor::One);
    color.setDestinationAlphaBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
    color.setAlphaBlendOperation(MTLBlendOperation::Add);
    color.setWriteMask(MTLColorWriteMask::All);
    device
        .compiler
        .newRenderPipelineStateWithDescriptor_compilerTaskOptions_error(&descriptor, None)
        .map_err(ns_error("making a pipeline"))
}

// MARK: Memory

/// A buffer the CPU writes (or reads) and the GPU reads (or writes) by
/// address: shared memory, which both see, mapped as long as it lives.
pub(super) struct HostBuffer {
    device: Arc<Device>,
    raw: Retained<ProtocolObject<dyn MTLBuffer>>,
    mapped: NonNull<u8>,
    capacity: usize,
    address: u64,
}

impl HostBuffer {
    /// A buffer of at least `bytes`; `read` if the CPU reads it back.
    pub(super) fn new(
        device: &Arc<Device>,
        bytes: usize,
        read: bool,
    ) -> Result<HostBuffer, String> {
        let capacity = bytes.max(4096).next_power_of_two();
        // What the CPU reads back is cached; what it only writes is
        // write-combined, as uncached memory, which reads slowly.
        let cache = if read {
            MTLResourceOptions::CPUCacheModeDefaultCache
        } else {
            MTLResourceOptions::CPUCacheModeWriteCombined
        };
        let raw = device
            .raw
            .newBufferWithLength_options(capacity, MTLResourceOptions::StorageModeShared | cache)
            .ok_or("metal: no memory for a buffer")?;
        let mapped = raw.contents().cast::<u8>();
        let address = raw.gpuAddress();
        device.set_resident(ProtocolObject::from_ref(&*raw), true);
        Ok(HostBuffer {
            device: device.clone(),
            raw,
            mapped,
            capacity,
            address,
        })
    }

    pub(super) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Its first `len` bytes (up to its capacity), as the GPU left them:
    /// once the GPU is done with everything it was given, and so done
    /// writing them. Nothing can copy into it while they are borrowed
    /// ([`Frame::draw`] takes it mutably).
    pub(super) fn read(&self, len: usize) -> Result<&[u8], String> {
        self.device.wait_idle()?;
        // SAFETY: shared memory of `capacity` bytes, which nothing writes
        // while it is borrowed: the GPU is done, and the CPU writes only
        // through &mut self.
        Ok(unsafe { std::slice::from_raw_parts(self.mapped.as_ptr(), len.min(self.capacity)) })
    }

    /// Its first `len` bytes, to fill. Only a [`Frame`] whose commands are
    /// done writes its buffers: nothing else uses them meanwhile.
    fn bytes_mut(&mut self, len: usize) -> &mut [u8] {
        assert!(
            len <= self.capacity,
            "a buffer of {} bytes, not {len}",
            self.capacity
        );
        // SAFETY: shared memory of `capacity` bytes, borrowed mutably from
        // its only owner, while the GPU uses it no more (see above).
        unsafe { std::slice::from_raw_parts_mut(self.mapped.as_ptr(), len) }
    }
}

impl Drop for HostBuffer {
    fn drop(&mut self) {
        // Commands that read or write it may still run: wait for them.
        let _ = self.device.wait_idle();
        self.device
            .set_resident(ProtocolObject::from_ref(&*self.raw), false);
    }
}

/// Puts `data` in `slot`'s buffer, first making it larger if it does not
/// fit; returns the buffer's address.
fn put(device: &Arc<Device>, slot: &mut Option<HostBuffer>, data: Data) -> Result<u64, String> {
    let len = data.len();
    if slot.as_ref().is_none_or(|b| b.capacity < len) {
        *slot = None;
        *slot = Some(HostBuffer::new(device, len, false)?);
    }
    let buffer = slot.as_mut().expect("made above");
    data.write(buffer.bytes_mut(len));
    Ok(buffer.address)
}

// MARK: Images and drawables

/// What a frame is drawn into: a texture of `extent` pixels, an [`Image`]'s
/// or a [`Drawable`]'s, which it borrows.
pub(super) struct Target<'a> {
    texture: &'a ProtocolObject<dyn MTLTexture>,
    pub(super) extent: [u32; 2],
}

/// An image on the device to draw into and copy from: frames drawn with no
/// window.
pub(super) struct Image {
    device: Arc<Device>,
    raw: Retained<ProtocolObject<dyn MTLTexture>>,
    pub(super) extent: [u32; 2],
}

impl Image {
    pub(super) fn new(
        device: &Arc<Device>,
        extent: [u32; 2],
        format: MTLPixelFormat,
    ) -> Result<Image, String> {
        let [width, height] = extent.map(|n| n.max(1) as usize);
        // SAFETY: a two-dimensional format, of at least a pixel each way.
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                format, width, height, false,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget);
        descriptor.setStorageMode(MTLStorageMode::Private);
        let raw = device
            .raw
            .newTextureWithDescriptor(&descriptor)
            .ok_or("metal: no memory for an image")?;
        device.set_resident(ProtocolObject::from_ref(&*raw), true);
        Ok(Image {
            device: device.clone(),
            raw,
            extent,
        })
    }

    pub(super) fn target(&self) -> Target<'_> {
        Target {
            texture: &self.raw,
            extent: self.extent,
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        // Commands that draw into it may still run: wait for them.
        let _ = self.device.wait_idle();
        self.device
            .set_resident(ProtocolObject::from_ref(&*self.raw), false);
    }
}

/// A window's layer: a `CAMetalLayer` that its view hosts, whose drawables
/// frames are drawn into and presented. It holds the window, and so its
/// view, and keeps its drawables resident for the device's queue.
pub(super) struct Layer {
    device: Arc<Device>,
    raw: Retained<CAMetalLayer>,
    residency: Retained<ProtocolObject<dyn MTLResidencySet>>,
    window: Arc<Window>,
}

impl Layer {
    /// The layer of `window`, drawn in `format`; one whose drawables can be
    /// copied from, if `copied`. It must be made on the main thread, where
    /// AppKit's views are.
    pub(super) fn new(
        device: &Arc<Device>,
        window: &Arc<Window>,
        format: MTLPixelFormat,
        copied: bool,
    ) -> Result<Layer, String> {
        let handle = window.window_handle().map_err(|e| e.to_string())?.as_raw();
        let RawWindowHandle::AppKit(handle) = handle else {
            return Err("only AppKit windows are supported".into());
        };
        MainThreadMarker::new().ok_or("metal: windows draw on the main thread")?;
        // SAFETY: the window's view, an NSView (winit's, for an AppKit
        // window), which lives as long as the window does; the layer holds
        // the window. This is the main thread, which AppKit's views
        // belong to.
        let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
        // SAFETY: an immutable string constant of CoreGraphics'.
        let srgb = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }));
        let raw = CAMetalLayer::new();
        raw.setDevice(Some(&device.raw));
        raw.setPixelFormat(format);
        raw.setFramebufferOnly(!copied);
        // The colors drawn are sRGB's, matched to the display's as a
        // terminal's are.
        raw.setColorspace(srgb.as_deref());
        raw.setOpaque(true);
        // The view hosts the layer, as its own: sized with it.
        view.setLayer(Some(&raw));
        view.setWantsLayer(true);
        let residency = raw.residencySet();
        device.queue.addResidencySet(&residency);
        let size = window.inner_size();
        let layer = Layer {
            device: device.clone(),
            raw,
            residency,
            window: window.clone(),
        };
        layer.resize([size.width, size.height]);
        Ok(layer)
    }

    /// Sizes its drawables for the window, now `size` pixels, at the
    /// window's scale.
    pub(super) fn resize(&self, [width, height]: [u32; 2]) {
        self.raw.setContentsScale(self.window.scale_factor());
        self.raw.setDrawableSize(CGSize {
            width: f64::from(width.max(1)),
            height: f64::from(height.max(1)),
        });
    }

    /// The next drawable to draw into, or None if there is none to have (in
    /// a second's time, which Core Animation waits at most).
    pub(super) fn next(&self) -> Option<Drawable> {
        let raw = self.raw.nextDrawable()?;
        let texture = raw.texture();
        let extent = [texture.width(), texture.height()].map(|n| n as u32);
        Some(Drawable {
            raw,
            texture,
            extent,
        })
    }
}

impl Drop for Layer {
    fn drop(&mut self) {
        // Frames presenting its drawables may still run: wait for them.
        let _ = self.device.wait_idle();
        self.device.queue.removeResidencySet(&self.residency);
    }
}

/// A drawable of a window's layer, to draw a frame into and present.
pub(super) struct Drawable {
    raw: Retained<ProtocolObject<dyn CAMetalDrawable>>,
    texture: Retained<ProtocolObject<dyn MTLTexture>>,
    pub(super) extent: [u32; 2],
}

impl Drawable {
    pub(super) fn target(&self) -> Target<'_> {
        Target {
            texture: &self.texture,
            extent: self.extent,
        }
    }

    fn drawable(&self) -> &ProtocolObject<dyn MTLDrawable> {
        ProtocolObject::from_ref(&*self.raw)
    }
}

// MARK: Frames

/// Each draw's [`Params`], this far apart in a frame's buffer of them: a
/// constant buffer's address must be 256-byte aligned on some GPUs.
const PARAMS_STRIDE: usize = 256;

/// A frame's data on the GPU, refilled each time it is drawn.
#[derive(Default)]
struct Buffers {
    rects: Option<HostBuffer>,
    glyphs: Option<HostBuffer>,
    decorations: Option<HostBuffer>,
    curves: Option<HostBuffer>,
    bands: Option<HostBuffer>,
    /// The atlas generation `curves` and `bands` hold.
    atlas: Option<u64>,
    pictures: Option<HostBuffer>,
    pixels: Option<HostBuffer>,
    /// The generation of the pixels `pixels` holds.
    pixels_generation: Option<u64>,
    /// Each draw's [`Params`].
    params: Option<HostBuffer>,
}

/// A frame in flight: its commands, the submission whose end says the GPU
/// is done with them, and the buffers they read.
pub(super) struct Frame {
    buffers: Buffers,
    device: Arc<Device>,
    allocator: Retained<ProtocolObject<dyn MTL4CommandAllocator>>,
    commands: Retained<ProtocolObject<dyn MTL4CommandBuffer>>,
    /// Where the pipelines find their [`Params`]: buffer 0.
    arguments: Retained<ProtocolObject<dyn MTL4ArgumentTable>>,
    /// The frame's last submission (0: none yet).
    submitted: u64,
}

impl Frame {
    pub(super) fn new(device: &Arc<Device>) -> Result<Frame, String> {
        let allocator = device
            .raw
            .newCommandAllocator()
            .ok_or("metal: cannot make a command allocator")?;
        let commands = device
            .raw
            .newCommandBuffer()
            .ok_or("metal: cannot make a command buffer")?;
        let table = MTL4ArgumentTableDescriptor::new();
        table.setMaxBufferBindCount(1);
        let arguments = device
            .raw
            .newArgumentTableWithDescriptor_error(&table)
            .map_err(ns_error("making an argument table"))?;
        Ok(Frame {
            buffers: Buffers::default(),
            device: device.clone(),
            allocator,
            commands,
            arguments,
            submitted: 0,
        })
    }

    /// Waits until the GPU is done with the frame's last commands.
    pub(super) fn wait(&self) -> Result<(), String> {
        self.device.wait_for(self.submitted)
    }

    /// Draws `list` into `target` with `pipelines`, once the frame's last
    /// commands are done: fills its buffers, records, and submits. The
    /// image is copied into `copy`, if there is one, once it is drawn. A
    /// `drawable`'s target is presented once drawn.
    pub(super) fn draw(
        &mut self,
        pipelines: &Pipelines,
        list: &DrawList,
        target: Target,
        copy: Option<&mut HostBuffer>,
        drawable: Option<&Drawable>,
    ) -> Result<(), String> {
        if !Arc::ptr_eq(&pipelines.device, &self.device) {
            return Err("metal: pipelines of another device".into());
        }
        self.wait()?;
        // The GPU is done with this frame's buffers: fill them.
        let device = &self.device;
        let b = &mut self.buffers;
        let rects = put(device, &mut b.rects, Data::Bytes(list.rects))?;
        let glyphs = put(device, &mut b.glyphs, Data::Bytes(list.glyphs))?;
        let decorations = put(device, &mut b.decorations, Data::Bytes(list.decorations))?;
        if b.atlas != Some(list.atlas.generation) || b.curves.is_none() {
            put(device, &mut b.curves, Data::Floats4(&list.atlas.curves))?;
            put(device, &mut b.bands, Data::Words2(&list.atlas.bands))?;
            b.atlas = Some(list.atlas.generation);
        }
        let curves = b.curves.as_ref().map_or(0, |b| b.address);
        let bands = b.bands.as_ref().map_or(0, |b| b.address);
        let pictures = put(device, &mut b.pictures, Data::Bytes(list.pictures))?;
        let (pixels, generation) = list.pixels;
        if b.pixels_generation != Some(generation) || b.pixels.is_none() {
            put(device, &mut b.pixels, Data::Words(pixels))?;
            b.pixels_generation = Some(generation);
        }
        let pixels = b.pixels.as_ref().map_or(0, |b| b.address);

        let linear = is_srgb(pipelines.format);
        let [r, g, bl] = clear_color(list.background, linear);
        let [width, height] = target.extent;
        let viewport = [width as f32, height as f32];
        let draws = [
            (&pipelines.rect, rects, list.rects.len() / RECT_BYTES),
            (
                &pipelines.image,
                pictures,
                list.pictures.len() / PICTURE_BYTES,
            ),
            (&pipelines.glyph, glyphs, list.glyphs.len() / GLYPH_BYTES),
            (
                &pipelines.rect,
                decorations,
                list.decorations.len() / RECT_BYTES,
            ),
        ];
        // Each draw's instances are at the start of its buffer: the
        // rectangle pipeline reads `rects`, the glyph one `glyphs`, the
        // image one `pictures`.
        let mut params = vec![0; draws.len() * PARAMS_STRIDE];
        for ((_, address, _), slot) in draws.iter().zip(params.chunks_exact_mut(PARAMS_STRIDE)) {
            let bytes = Params {
                rects: *address,
                glyphs: *address,
                curves,
                bands,
                pictures: *address,
                pixels,
                cell: list.cell,
                viewport,
                origin: list.origin,
                linear: u32::from(linear),
            }
            .bytes();
            slot[..bytes.len()].copy_from_slice(&bytes);
        }
        let params = put(device, &mut b.params, Data::Bytes(&params))?;

        let pass = MTL4RenderPassDescriptor::new();
        // SAFETY: the first of the pass's color attachments, of which it has
        // eight.
        let color = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
        color.setTexture(Some(target.texture));
        color.setLoadAction(MTLLoadAction::Clear);
        color.setStoreAction(MTLStoreAction::Store);
        color.setClearColor(MTLClearColor {
            red: f64::from(r),
            green: f64::from(g),
            blue: f64::from(bl),
            alpha: 1.0,
        });
        // The allocator's memory is the frame's last commands', which the
        // GPU is done with (waited for above).
        self.allocator.reset();
        self.commands
            .beginCommandBufferWithAllocator(&self.allocator);
        let encoder = self
            .commands
            .renderCommandEncoderWithDescriptor(&pass)
            .ok_or("metal: cannot draw into this image")?;
        encoder.setViewport(MTLViewport {
            originX: 0.0,
            originY: 0.0,
            width: f64::from(viewport[0]),
            height: f64::from(viewport[1]),
            znear: 0.0,
            zfar: 1.0,
        });
        // A draw takes the table's bindings as they are when it is
        // encoded, so each binds its own Params.
        encoder.setArgumentTable_atStages(
            &self.arguments,
            MTLRenderStages::Vertex | MTLRenderStages::Fragment,
        );
        for (i, (pipeline, _, count)) in draws.iter().enumerate() {
            if *count == 0 {
                continue;
            }
            encoder.setRenderPipelineState(pipeline);
            // SAFETY: the address of the Params of this draw, in a buffer
            // of the frame's, resident, which it keeps until the GPU is done
            // with its commands; and four vertices of each of `count`
            // instances, whose data the Params point at, in buffers the
            // frame keeps likewise.
            unsafe {
                self.arguments
                    .setAddress_atIndex(params + (i * PARAMS_STRIDE) as u64, 0);
                encoder.drawPrimitives_vertexStart_vertexCount_instanceCount(
                    MTLPrimitiveType::TriangleStrip,
                    0,
                    4,
                    *count,
                );
            }
        }
        encoder.endEncoding();
        if let Some(copy) = copy {
            // Only what fits: a buffer smaller than the image takes none of
            // it.
            let bytes = width as usize * height as usize * 4;
            if copy.capacity >= bytes {
                let blit = self
                    .commands
                    .computeCommandEncoder()
                    .ok_or("metal: cannot copy the image")?;
                // Copied once it is drawn: Metal 4 orders passes only so.
                blit.barrierAfterQueueStages_beforeStages_visibilityOptions(
                    MTLStages::All,
                    MTLStages::Blit,
                    MTL4VisibilityOptions::Device,
                );
                // SAFETY: the whole of the target, drawn above, into the
                // start of a resident buffer big enough for it (checked),
                // which the caller lends mutably while the frame is drawn
                // and reads only once the GPU is done.
                unsafe {
                    blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toBuffer_destinationOffset_destinationBytesPerRow_destinationBytesPerImage(
                        target.texture,
                        0,
                        0,
                        MTLOrigin { x: 0, y: 0, z: 0 },
                        MTLSize {
                            width: width as usize,
                            height: height as usize,
                            depth: 1,
                        },
                        &copy.raw,
                        0,
                        width as usize * 4,
                        bytes,
                    )
                };
                blit.endEncoding();
            }
        }
        self.commands.endCommandBuffer();

        let queue = &device.queue;
        // A drawable is drawn into once the display is done with it, and
        // shown once drawn.
        if let Some(drawable) = drawable {
            queue.waitForDrawable(drawable.drawable());
        }
        let commands = [NonNull::from(&*self.commands)];
        // SAFETY: one command buffer, ended, of this device's: what it uses
        // is resident and lives until the GPU is done with it, which the
        // frame waits for before it records again. The windows' thread is
        // the only one that submits to a window's queue, and a headless
        // renderer's device is its own.
        unsafe { queue.commit_count(NonNull::from(&commands).cast(), 1) };
        if let Some(drawable) = drawable {
            queue.signalDrawable(drawable.drawable());
            drawable.drawable().present();
        }
        let number = device.submitted.fetch_add(1, Ordering::AcqRel) + 1;
        queue.signalEvent_value(ProtocolObject::from_ref(&*device.event), number);
        self.submitted = number;
        Ok(())
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        // Its commands may still run: wait for them, before its buffers go.
        let _ = self.wait();
    }
}

/// Whether frames drawn in `format` blend in linear light: whether it
/// encodes sRGB itself.
pub(super) fn is_srgb(format: MTLPixelFormat) -> bool {
    matches!(
        format,
        MTLPixelFormat::BGRA8Unorm_sRGB | MTLPixelFormat::RGBA8Unorm_sRGB
    )
}
