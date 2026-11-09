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
//! (image.rs), then glyphs (font.rs lays them out; slug.rs makes their
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

// MARK: The device

/// A buffer the CPU writes and the GPU reads by address.
struct HostBuffer {
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: *mut u8,
    capacity: usize,
    address: vk::DeviceAddress,
}

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
}

/// A frame's commands, and the fence that says the GPU is done with them.
struct Commands {
    pool: vk::CommandPool,
    buffer: vk::CommandBuffer,
    done: vk::Fence,
}

/// Where a frame is drawn: an image, left in `layout` afterwards, and
/// copied to `copy` first if there is one.
struct Target {
    image: vk::Image,
    view: vk::ImageView,
    extent: vk::Extent2D,
    layout: vk::ImageLayout,
    copy: Option<vk::Buffer>,
}

/// Vulkan, a device and its pipelines: what drawing needs, with a window
/// or without one. Dropping it destroys the device and the instance.
pub struct Gpu {
    // Kept for the library ash loaded: everything else calls into it.
    entry: ash::Entry,
    instance: ash::Instance,
    physical: vk::PhysicalDevice,
    memory: vk::PhysicalDeviceMemoryProperties,
    device: ash::Device,
    queue: vk::Queue,
    family: u32,
    format: vk::Format,
    layout: vk::PipelineLayout,
    rect_pipeline: vk::Pipeline,
    glyph_pipeline: vk::Pipeline,
    image_pipeline: vk::Pipeline,
    /// Whether presenting can say what changed (VK_KHR_incremental_present).
    incremental_present: bool,
}

/// Loads Vulkan and makes an instance with `extensions`.
fn instance(extensions: &[&CStr]) -> Result<(ash::Entry, ash::Instance), String> {
    // SAFETY: loading the Vulkan loader runs its initializers, which is
    // what it is for.
    let entry = unsafe { ash::Entry::load() }.map_err(|e| {
        format!(
            "cannot load Vulkan (libvulkan.so.1): {e}; is this the host-linked quad (:quad-host)?"
        )
    })?;
    let extensions: Vec<*const c_char> = extensions.iter().map(|e| e.as_ptr()).collect();
    let validation = c"VK_LAYER_KHRONOS_validation";
    let layers: Vec<*const c_char> =
        if std::env::var_os("QUAD_VULKAN_VALIDATION").is_some_and(|v| v == "1") {
            vec![validation.as_ptr()]
        } else {
            Vec::new()
        };
    let app = vk::ApplicationInfo::default()
        .application_name(c"quad")
        .engine_name(c"quad")
        .api_version(vk::API_VERSION_1_3);
    let instance = unsafe {
        entry.create_instance(
            &vk::InstanceCreateInfo::default()
                .application_info(&app)
                .enabled_extension_names(&extensions)
                .enabled_layer_names(&layers),
            None,
        )
    }
    .map_err(vk_error("creating an instance"))?;
    timing::mark("vulkan loaded");
    Ok((entry, instance))
}

impl Gpu {
    /// Makes the device, its pipelines drawing in `format`. On failure,
    /// what it made is gone again, and the instance is the caller's.
    unsafe fn new(
        entry: ash::Entry,
        instance: ash::Instance,
        physical: vk::PhysicalDevice,
        family: u32,
        format: vk::Format,
        swapchain: bool,
    ) -> Result<Gpu, (ash::Instance, String)> {
        let (device, incremental_present) =
            match unsafe { create_device(&instance, physical, family, swapchain) } {
                Ok(made) => made,
                Err(error) => return Err((instance, error)),
            };
        timing::mark("device made");
        let memory = unsafe { instance.get_physical_device_memory_properties(physical) };
        let queue = unsafe { device.get_device_queue(family, 0) };
        let mut gpu = Gpu {
            entry,
            instance,
            physical,
            memory,
            device,
            queue,
            family,
            format,
            layout: vk::PipelineLayout::null(),
            rect_pipeline: vk::Pipeline::null(),
            glyph_pipeline: vk::Pipeline::null(),
            image_pipeline: vk::Pipeline::null(),
            incremental_present,
        };
        // From here on, Drop cleans up after a failure.
        match unsafe { gpu.pipelines() } {
            Ok(()) => Ok(gpu),
            Err(error) => {
                unsafe {
                    gpu.destroy_device();
                }
                let instance = gpu.instance.clone();
                std::mem::forget(gpu);
                Err((instance, error))
            }
        }
    }

    /// Draws in `format` from now on: pipelines made again for it.
    unsafe fn set_format(&mut self, format: vk::Format) -> Result<(), String> {
        unsafe {
            let _ = self.device.device_wait_idle();
            for p in [self.rect_pipeline, self.glyph_pipeline, self.image_pipeline] {
                if p != vk::Pipeline::null() {
                    self.device.destroy_pipeline(p, None);
                }
            }
            self.device.destroy_pipeline_layout(self.layout, None);
        }
        self.rect_pipeline = vk::Pipeline::null();
        self.glyph_pipeline = vk::Pipeline::null();
        self.image_pipeline = vk::Pipeline::null();
        self.layout = vk::PipelineLayout::null();
        self.format = format;
        unsafe { self.pipelines() }
    }

    unsafe fn pipelines(&mut self) -> Result<(), String> {
        let push = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT)
            .size(size_of::<Params>() as u32)];
        self.layout = unsafe {
            self.device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default().push_constant_ranges(&push),
                None,
            )
        }
        .map_err(vk_error("creating the pipeline layout"))?;
        self.rect_pipeline = unsafe { self.create_pipeline(RECT_VERTEX, RECT_FRAGMENT) }?;
        self.glyph_pipeline = unsafe { self.create_pipeline(GLYPH_VERTEX, GLYPH_FRAGMENT) }?;
        self.image_pipeline = unsafe { self.create_pipeline(IMAGE_VERTEX, IMAGE_FRAGMENT) }?;
        timing::mark("pipelines made");
        Ok(())
    }

    /// A pipeline drawing four-vertex strips, blending by alpha over what
    /// was drawn before. Each SPIR-V module has one entry point.
    unsafe fn create_pipeline(
        &self,
        vertex: &[u8],
        fragment: &[u8],
    ) -> Result<vk::Pipeline, String> {
        let module = |code: &[u8]| {
            let words: Vec<u32> = code
                .chunks_exact(4)
                .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                .collect();
            unsafe {
                self.device
                    .create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&words), None)
            }
            .map_err(vk_error("creating a shader module"))
        };
        let entry = |code: &[u8]| -> Result<std::ffi::CString, String> {
            entry_point_name(code).ok_or_else(|| "a shader has no entry point".to_string())
        };
        let (vertex_name, fragment_name) = (entry(vertex)?, entry(fragment)?);
        let vertex = module(vertex)?;
        let fragment = match module(fragment) {
            Ok(fragment) => fragment,
            Err(error) => {
                unsafe { self.device.destroy_shader_module(vertex, None) };
                return Err(error);
            }
        };
        let stages = [
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::VERTEX)
                .module(vertex)
                .name(&vertex_name),
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::FRAGMENT)
                .module(fragment)
                .name(&fragment_name),
        ];
        let input = vk::PipelineVertexInputStateCreateInfo::default();
        let assembly = vk::PipelineInputAssemblyStateCreateInfo::default()
            .topology(vk::PrimitiveTopology::TRIANGLE_STRIP);
        let viewport = vk::PipelineViewportStateCreateInfo::default()
            .viewport_count(1)
            .scissor_count(1);
        let raster = vk::PipelineRasterizationStateCreateInfo::default()
            .polygon_mode(vk::PolygonMode::FILL)
            .cull_mode(vk::CullModeFlags::NONE)
            .line_width(1.0);
        let multisample = vk::PipelineMultisampleStateCreateInfo::default()
            .rasterization_samples(vk::SampleCountFlags::TYPE_1);
        let blend = [vk::PipelineColorBlendAttachmentState::default()
            .blend_enable(true)
            .src_color_blend_factor(vk::BlendFactor::SRC_ALPHA)
            .dst_color_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
            .color_blend_op(vk::BlendOp::ADD)
            .src_alpha_blend_factor(vk::BlendFactor::ONE)
            .dst_alpha_blend_factor(vk::BlendFactor::ONE_MINUS_SRC_ALPHA)
            .alpha_blend_op(vk::BlendOp::ADD)
            .color_write_mask(vk::ColorComponentFlags::RGBA)];
        let blending = vk::PipelineColorBlendStateCreateInfo::default().attachments(&blend);
        let dynamic = [vk::DynamicState::VIEWPORT, vk::DynamicState::SCISSOR];
        let dynamic = vk::PipelineDynamicStateCreateInfo::default().dynamic_states(&dynamic);
        let formats = [self.format];
        let mut rendering =
            vk::PipelineRenderingCreateInfo::default().color_attachment_formats(&formats);
        let info = vk::GraphicsPipelineCreateInfo::default()
            .push_next(&mut rendering)
            .stages(&stages)
            .vertex_input_state(&input)
            .input_assembly_state(&assembly)
            .viewport_state(&viewport)
            .rasterization_state(&raster)
            .multisample_state(&multisample)
            .color_blend_state(&blending)
            .dynamic_state(&dynamic)
            .layout(self.layout);
        let pipelines = unsafe {
            self.device
                .create_graphics_pipelines(vk::PipelineCache::null(), &[info], None)
        };
        unsafe {
            self.device.destroy_shader_module(vertex, None);
            self.device.destroy_shader_module(fragment, None);
        }
        pipelines
            .map(|p| p[0])
            .map_err(|(_, e)| vk_error("creating a pipeline")(e))
    }

    unsafe fn commands(&self) -> Result<Commands, String> {
        let pool = unsafe {
            self.device.create_command_pool(
                &vk::CommandPoolCreateInfo::default()
                    .queue_family_index(self.family)
                    .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
                None,
            )
        }
        .map_err(vk_error("creating a command pool"))?;
        let made = unsafe {
            self.device
                .allocate_command_buffers(
                    &vk::CommandBufferAllocateInfo::default()
                        .command_pool(pool)
                        .level(vk::CommandBufferLevel::PRIMARY)
                        .command_buffer_count(1),
                )
                .and_then(|buffers| {
                    self.device
                        .create_fence(
                            &vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED),
                            None,
                        )
                        .map(|done| (buffers[0], done))
                })
        };
        match made {
            Ok((buffer, done)) => Ok(Commands { pool, buffer, done }),
            Err(e) => {
                unsafe { self.device.destroy_command_pool(pool, None) };
                Err(vk_error("allocating commands")(e))
            }
        }
    }

    unsafe fn destroy_commands(&self, c: Commands) {
        unsafe {
            self.device.destroy_fence(c.done, None);
            self.device.destroy_command_pool(c.pool, None);
        }
    }

    unsafe fn destroy_buffers(&self, b: Buffers) {
        for buffer in [
            b.rects,
            b.glyphs,
            b.decorations,
            b.curves,
            b.bands,
            b.pictures,
            b.pixels,
        ]
        .into_iter()
        .flatten()
        {
            unsafe { destroy_buffer(&self.device, buffer) };
        }
    }

    unsafe fn wait(&self, c: &Commands) -> Result<(), String> {
        unsafe { self.device.wait_for_fences(&[c.done], true, u64::MAX) }
            .map_err(vk_error("waiting for a frame"))
    }

    /// Fills `buffers` with `list`'s data and records drawing it into
    /// `target`. The GPU must be done with `buffers` and `commands`.
    unsafe fn record(
        &self,
        commands: &Commands,
        buffers: &mut Buffers,
        list: &DrawList,
        target: &Target,
    ) -> Result<(), String> {
        let (d, m) = (&self.device, &self.memory);
        let rects = unsafe { write(d, m, &mut buffers.rects, list.rects) }?;
        let glyphs = unsafe { write(d, m, &mut buffers.glyphs, list.glyphs) }?;
        let decorations = unsafe { write(d, m, &mut buffers.decorations, list.decorations) }?;
        if buffers.atlas != Some(list.atlas.generation) || buffers.curves.is_none() {
            unsafe {
                write(d, m, &mut buffers.curves, bytes_of(&list.atlas.curves))?;
                write(d, m, &mut buffers.bands, bytes_of(&list.atlas.bands))?;
            }
            buffers.atlas = Some(list.atlas.generation);
        }
        let curves = buffers.curves.as_ref().map_or(0, |b| b.address);
        let bands = buffers.bands.as_ref().map_or(0, |b| b.address);
        let pictures = unsafe { write(d, m, &mut buffers.pictures, list.pictures) }?;
        let (pixels, generation) = list.pixels;
        if buffers.pixels_generation != Some(generation) || buffers.pixels.is_none() {
            unsafe { write(d, m, &mut buffers.pixels, bytes_of(pixels)) }?;
            buffers.pixels_generation = Some(generation);
        }
        let pixels = buffers.pixels.as_ref().map_or(0, |b| b.address);

        let c = commands.buffer;
        let extent = target.extent;
        unsafe {
            d.reset_command_buffer(c, vk::CommandBufferResetFlags::empty())
                .map_err(vk_error("resetting commands"))?;
            d.begin_command_buffer(
                c,
                &vk::CommandBufferBeginInfo::default()
                    .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
            )
            .map_err(vk_error("recording commands"))?;
            barrier(
                d,
                c,
                target.image,
                (
                    vk::ImageLayout::UNDEFINED,
                    vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
                ),
                (
                    vk::AccessFlags2::NONE,
                    vk::AccessFlags2::COLOR_ATTACHMENT_WRITE,
                ),
            );
            let linear = is_srgb(self.format);
            let [r, g, b] = [16, 8, 0].map(|shift| {
                let v = f32::from(((list.background >> shift) & 0xFF) as u8) / 255.0;
                if linear { linearize(v) } else { v }
            });
            let attachments = [vk::RenderingAttachmentInfo::default()
                .image_view(target.view)
                .image_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
                .load_op(vk::AttachmentLoadOp::CLEAR)
                .store_op(vk::AttachmentStoreOp::STORE)
                .clear_value(vk::ClearValue {
                    color: vk::ClearColorValue {
                        float32: [r, g, b, 1.0],
                    },
                })];
            let area = vk::Rect2D {
                offset: vk::Offset2D::default(),
                extent,
            };
            d.cmd_begin_rendering(
                c,
                &vk::RenderingInfo::default()
                    .render_area(area)
                    .layer_count(1)
                    .color_attachments(&attachments),
            );
            d.cmd_set_viewport(
                c,
                0,
                &[vk::Viewport {
                    x: 0.0,
                    y: 0.0,
                    width: extent.width as f32,
                    height: extent.height as f32,
                    min_depth: 0.0,
                    max_depth: 1.0,
                }],
            );
            d.cmd_set_scissor(c, 0, &[area]);
            let viewport = [extent.width as f32, extent.height as f32];
            let draws = [
                (self.rect_pipeline, rects, list.rects.len() / RECT_BYTES),
                (
                    self.image_pipeline,
                    pictures,
                    list.pictures.len() / PICTURE_BYTES,
                ),
                (self.glyph_pipeline, glyphs, list.glyphs.len() / GLYPH_BYTES),
                (
                    self.rect_pipeline,
                    decorations,
                    list.decorations.len() / RECT_BYTES,
                ),
            ];
            for (pipeline, address, count) in draws {
                if count == 0 {
                    continue;
                }
                d.cmd_bind_pipeline(c, vk::PipelineBindPoint::GRAPHICS, pipeline);
                // Each draw's instances are at the start of its buffer;
                // the rectangle pipeline reads `rects`, the glyph one
                // `glyphs`, the image one `pictures`.
                let params = Params {
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
                    reserved: 0,
                };
                d.cmd_push_constants(
                    c,
                    self.layout,
                    vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT,
                    0,
                    std::slice::from_raw_parts(
                        (&raw const params).cast::<u8>(),
                        size_of::<Params>(),
                    ),
                );
                d.cmd_draw(c, 4, count as u32, 0, 0);
            }
            d.cmd_end_rendering(c);
            let mut layout = vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL;
            if let Some(buffer) = target.copy {
                barrier(
                    d,
                    c,
                    target.image,
                    (layout, vk::ImageLayout::TRANSFER_SRC_OPTIMAL),
                    (
                        vk::AccessFlags2::COLOR_ATTACHMENT_WRITE,
                        vk::AccessFlags2::TRANSFER_READ,
                    ),
                );
                layout = vk::ImageLayout::TRANSFER_SRC_OPTIMAL;
                d.cmd_copy_image_to_buffer(
                    c,
                    target.image,
                    layout,
                    buffer,
                    &[vk::BufferImageCopy::default()
                        .image_subresource(vk::ImageSubresourceLayers {
                            aspect_mask: vk::ImageAspectFlags::COLOR,
                            mip_level: 0,
                            base_array_layer: 0,
                            layer_count: 1,
                        })
                        .image_extent(vk::Extent3D {
                            width: extent.width,
                            height: extent.height,
                            depth: 1,
                        })],
                );
            }
            if layout != target.layout {
                barrier(
                    d,
                    c,
                    target.image,
                    (layout, target.layout),
                    (vk::AccessFlags2::MEMORY_WRITE, vk::AccessFlags2::NONE),
                );
            }
            d.end_command_buffer(c)
                .map_err(vk_error("recording commands"))
        }
    }

    /// Submits recorded commands; their fence is signaled when they are
    /// done.
    unsafe fn submit(
        &self,
        commands: &Commands,
        wait: Option<vk::Semaphore>,
        signal: Option<vk::Semaphore>,
    ) -> Result<(), String> {
        let waits: Vec<_> = wait
            .into_iter()
            .map(|s| {
                vk::SemaphoreSubmitInfo::default()
                    .semaphore(s)
                    .stage_mask(vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT)
            })
            .collect();
        let signals: Vec<_> = signal
            .into_iter()
            .map(|s| {
                vk::SemaphoreSubmitInfo::default()
                    .semaphore(s)
                    .stage_mask(vk::PipelineStageFlags2::ALL_COMMANDS)
            })
            .collect();
        let buffers = [vk::CommandBufferSubmitInfo::default().command_buffer(commands.buffer)];
        unsafe {
            self.device
                .reset_fences(&[commands.done])
                .map_err(vk_error("resetting a fence"))?;
            self.device
                .queue_submit2(
                    self.queue,
                    &[vk::SubmitInfo2::default()
                        .wait_semaphore_infos(&waits)
                        .command_buffer_infos(&buffers)
                        .signal_semaphore_infos(&signals)],
                    commands.done,
                )
                .map_err(vk_error("submitting"))
        }
    }

    unsafe fn destroy_device(&mut self) {
        unsafe {
            let _ = self.device.device_wait_idle();
            if self.rect_pipeline != vk::Pipeline::null() {
                self.device.destroy_pipeline(self.rect_pipeline, None);
            }
            if self.glyph_pipeline != vk::Pipeline::null() {
                self.device.destroy_pipeline(self.glyph_pipeline, None);
            }
            if self.image_pipeline != vk::Pipeline::null() {
                self.device.destroy_pipeline(self.image_pipeline, None);
            }
            if self.layout != vk::PipelineLayout::null() {
                self.device.destroy_pipeline_layout(self.layout, None);
            }
            self.device.destroy_device(None);
        }
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        unsafe {
            self.destroy_device();
            self.instance.destroy_instance(None);
        }
    }
}

// MARK: In a window

struct Swapchain {
    swapchain: vk::SwapchainKHR,
    images: Vec<vk::Image>,
    views: Vec<vk::ImageView>,
    /// Signaled when an image's commands are done, for presenting it: one
    /// per image, since presentation holds it until the image comes back.
    rendered: Vec<vk::Semaphore>,
    extent: vk::Extent2D,
}

/// One frame in flight: its commands, its data, and the semaphore its
/// swapchain image is acquired with.
struct InFlight {
    commands: Commands,
    buffers: Buffers,
    acquired: vk::Semaphore,
}

/// Draws frames in a window.
pub struct Renderer {
    surface_fn: ash::khr::surface::Instance,
    surface: vk::SurfaceKHR,
    swapchain_fn: ash::khr::swapchain::Device,
    surface_format: vk::SurfaceFormatKHR,
    present_mode: vk::PresentModeKHR,
    swapchain: Option<Swapchain>,
    /// The window's size, for surfaces that have none of their own
    /// (Wayland's).
    size: PhysicalSize<u32>,
    stale: bool,
    /// The swapchain's images are new: the next frame changes all of the
    /// window, whatever its damage says.
    fresh: bool,
    frames: Vec<InFlight>,
    frame: usize,
    /// With `QUAD_GUI_SNAPSHOT=FILE`, each frame presented is also written
    /// to FILE, as a PPM image: what the window shows.
    snapshot: Option<std::path::PathBuf>,
    snapshot_buffer: Option<HostBuffer>,
    // Last, so that it is dropped last: everything above is its device's,
    // which other windows' renderers may share.
    gpu: Rc<Gpu>,
}

impl Renderer {
    /// A renderer drawing into `window`, on the device `shared` holds: the
    /// one every window of this process draws with, made for the first
    /// window that needs it.
    pub fn new(window: &Window, shared: &mut Option<Rc<Gpu>>) -> Result<Renderer, String> {
        let display = window.display_handle().map_err(|e| e.to_string())?.as_raw();
        let handle = window.window_handle().map_err(|e| e.to_string())?.as_raw();
        if let Some(gpu) = shared {
            return Renderer::on(gpu.clone(), display, handle, window.inner_size());
        }
        let surface_extension = match display {
            RawDisplayHandle::Wayland(_) => ash::khr::wayland_surface::NAME,
            RawDisplayHandle::Xlib(_) => ash::khr::xlib_surface::NAME,
            _ => return Err("only Wayland and X11 (Xlib) windows are supported".into()),
        };
        if let Some(gpu) = unsafe { take_prepared(surface_extension, display, handle) } {
            let gpu = Rc::new(gpu);
            *shared = Some(gpu.clone());
            return Renderer::on(gpu, display, handle, window.inner_size());
        }
        let (entry, instance) = instance(&[ash::khr::surface::NAME, surface_extension])?;
        let surface_fn = ash::khr::surface::Instance::new(&entry, &instance);
        // The device is chosen for the first window's surface, which is
        // made only to choose it.
        let surface = match unsafe { create_surface(&entry, &instance, display, handle) } {
            Ok(surface) => surface,
            Err(error) => {
                unsafe { instance.destroy_instance(None) };
                return Err(error);
            }
        };
        let picked = unsafe { pick_device(&instance, Some((&surface_fn, surface))) }.and_then(
            |(physical, family)| {
                unsafe { surface_format(&surface_fn, physical, surface) }
                    .map(|format| (physical, family, format))
            },
        );
        unsafe { surface_fn.destroy_surface(surface, None) };
        let (physical, family, format) = match picked {
            Ok(picked) => picked,
            Err(error) => {
                unsafe { instance.destroy_instance(None) };
                return Err(error);
            }
        };
        let gpu = match unsafe { Gpu::new(entry, instance, physical, family, format.format, true) }
        {
            Ok(gpu) => Rc::new(gpu),
            Err((instance, error)) => {
                unsafe { instance.destroy_instance(None) };
                return Err(error);
            }
        };
        *shared = Some(gpu.clone());
        Renderer::on(gpu, display, handle, window.inner_size())
    }

    /// A renderer on `gpu` for the window with these handles.
    fn on(
        gpu: Rc<Gpu>,
        display: RawDisplayHandle,
        handle: RawWindowHandle,
        size: PhysicalSize<u32>,
    ) -> Result<Renderer, String> {
        let surface_fn = ash::khr::surface::Instance::new(&gpu.entry, &gpu.instance);
        let surface = unsafe { create_surface(&gpu.entry, &gpu.instance, display, handle) }?;
        let usable = unsafe {
            surface_fn.get_physical_device_surface_support(gpu.physical, gpu.family, surface)
        }
        .unwrap_or(false);
        let surface_format = if usable {
            unsafe { surface_format(&surface_fn, gpu.physical, surface) }
        } else {
            Err("the device cannot draw to this window".into())
        };
        // The pipelines draw in the format the device was set up with.
        let surface_format = match surface_format {
            Ok(f) if f.format == gpu.format => f,
            other => {
                unsafe { surface_fn.destroy_surface(surface, None) };
                return Err(match other {
                    Err(error) => error,
                    Ok(_) => "this window takes another color format than the others".into(),
                });
            }
        };
        let swapchain_fn = ash::khr::swapchain::Device::new(&gpu.instance, &gpu.device);
        let mut renderer = Renderer {
            surface_fn,
            surface,
            swapchain_fn,
            surface_format,
            present_mode: vk::PresentModeKHR::FIFO,
            swapchain: None,
            size,
            stale: true,
            fresh: true,
            frames: Vec::new(),
            frame: 0,
            snapshot: std::env::var_os("QUAD_GUI_SNAPSHOT").map(Into::into),
            snapshot_buffer: None,
            gpu,
        };
        // From here on, Drop cleans up after a failure.
        unsafe { renderer.init() }?;
        Ok(renderer)
    }

    unsafe fn init(&mut self) -> Result<(), String> {
        // FIFO, which every device has: frames are drawn only when the
        // compositor asks for one (gui.rs draws at its frame callbacks),
        // so none waits, and none is drawn to be thrown away, as mailbox
        // would.
        self.present_mode = vk::PresentModeKHR::FIFO;
        for _ in 0..FRAMES_IN_FLIGHT {
            let commands = unsafe { self.gpu.commands() }?;
            let acquired = match unsafe {
                self.gpu
                    .device
                    .create_semaphore(&vk::SemaphoreCreateInfo::default(), None)
            } {
                Ok(acquired) => acquired,
                Err(e) => {
                    unsafe { self.gpu.destroy_commands(commands) };
                    return Err(vk_error("creating a semaphore")(e));
                }
            };
            self.frames.push(InFlight {
                commands,
                buffers: Buffers::default(),
                acquired,
            });
        }
        Ok(())
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) {
        if size != self.size {
            self.size = size;
            self.stale = true;
        }
    }

    /// (Re)makes the swapchain for the surface's current size. Returns
    /// false while the window has no area to draw.
    unsafe fn ensure_swapchain(&mut self) -> Result<bool, String> {
        if !self.stale && self.swapchain.is_some() {
            return Ok(true);
        }
        let caps = unsafe {
            self.surface_fn
                .get_physical_device_surface_capabilities(self.gpu.physical, self.surface)
        }
        .map_err(vk_error("reading the surface's capabilities"))?;
        let extent = if caps.current_extent.width != u32::MAX {
            caps.current_extent
        } else {
            vk::Extent2D {
                width: self
                    .size
                    .width
                    .clamp(caps.min_image_extent.width, caps.max_image_extent.width),
                height: self
                    .size
                    .height
                    .clamp(caps.min_image_extent.height, caps.max_image_extent.height),
            }
        };
        if extent.width == 0 || extent.height == 0 {
            return Ok(false);
        }
        unsafe { self.gpu.device.device_wait_idle() }
            .map_err(vk_error("waiting for the device"))?;
        let mut count = caps.min_image_count + 1;
        if caps.max_image_count > 0 {
            count = count.min(caps.max_image_count);
        }
        let alpha = [
            vk::CompositeAlphaFlagsKHR::OPAQUE,
            vk::CompositeAlphaFlagsKHR::INHERIT,
            vk::CompositeAlphaFlagsKHR::PRE_MULTIPLIED,
            vk::CompositeAlphaFlagsKHR::POST_MULTIPLIED,
        ]
        .into_iter()
        .find(|&a| caps.supported_composite_alpha.contains(a))
        .unwrap_or(vk::CompositeAlphaFlagsKHR::OPAQUE);
        let usage = if self.snapshot.is_some() {
            vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC
        } else {
            vk::ImageUsageFlags::COLOR_ATTACHMENT
        };
        let old = self.swapchain.take();
        let created = unsafe {
            self.swapchain_fn.create_swapchain(
                &vk::SwapchainCreateInfoKHR::default()
                    .surface(self.surface)
                    .min_image_count(count)
                    .image_format(self.surface_format.format)
                    .image_color_space(self.surface_format.color_space)
                    .image_extent(extent)
                    .image_array_layers(1)
                    .image_usage(usage)
                    .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .pre_transform(caps.current_transform)
                    .composite_alpha(alpha)
                    .present_mode(self.present_mode)
                    .clipped(true)
                    .old_swapchain(
                        old.as_ref()
                            .map_or(vk::SwapchainKHR::null(), |s| s.swapchain),
                    ),
                None,
            )
        };
        if let Some(old) = old {
            unsafe { self.destroy_swapchain(old) };
        }
        let swapchain = created.map_err(vk_error("creating the swapchain"))?;
        let mut made = Swapchain {
            swapchain,
            images: Vec::new(),
            views: Vec::new(),
            rendered: Vec::new(),
            extent,
        };
        let result = unsafe { self.fill_swapchain(&mut made) };
        self.swapchain = Some(made);
        result?;
        self.stale = false;
        self.fresh = true;
        Ok(true)
    }

    unsafe fn fill_swapchain(&self, s: &mut Swapchain) -> Result<(), String> {
        let d = &self.gpu.device;
        s.images = unsafe { self.swapchain_fn.get_swapchain_images(s.swapchain) }
            .map_err(vk_error("listing swapchain images"))?;
        for &image in &s.images {
            s.views
                .push(unsafe { image_view(d, image, self.surface_format.format) }?);
            let rendered = unsafe { d.create_semaphore(&vk::SemaphoreCreateInfo::default(), None) }
                .map_err(vk_error("creating a semaphore"))?;
            s.rendered.push(rendered);
        }
        Ok(())
    }

    unsafe fn destroy_swapchain(&self, s: Swapchain) {
        let d = &self.gpu.device;
        unsafe {
            for view in s.views {
                d.destroy_image_view(view, None);
            }
            for semaphore in s.rendered {
                d.destroy_semaphore(semaphore, None);
            }
            self.swapchain_fn.destroy_swapchain(s.swapchain, None);
        }
    }

    /// Draws and presents a frame; returns whether it did, or whether it
    /// must be tried again (when the window is visible, or has a size).
    /// `damage` is what changed since the last frame presented, as
    /// rectangles in pixels (x, y, width, height), for the compositor to
    /// redraw only those; None, everything.
    pub fn draw(&mut self, list: &DrawList, damage: Option<&[[u32; 4]]>) -> Result<bool, String> {
        unsafe { self.draw_frame(list, damage) }
    }

    unsafe fn draw_frame(
        &mut self,
        list: &DrawList,
        damage: Option<&[[u32; 4]]>,
    ) -> Result<bool, String> {
        if !unsafe { self.ensure_swapchain() }? {
            return Ok(false);
        }
        let f = self.frame;
        unsafe { self.gpu.wait(&self.frames[f].commands) }?;
        let swapchain = self.swapchain.as_ref().expect("made above");
        // Not forever: a compositor keeps a hidden window's images (a
        // minimized window, a locked screen), and the window's thread must
        // go on handling its events meanwhile.
        let acquired = unsafe {
            self.swapchain_fn.acquire_next_image(
                swapchain.swapchain,
                ACQUIRE_TIMEOUT_NS,
                self.frames[f].acquired,
                vk::Fence::null(),
            )
        };
        let index = match acquired {
            Ok((index, suboptimal)) => {
                self.stale |= suboptimal;
                index as usize
            }
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => {
                self.stale = true;
                return Ok(false);
            }
            Err(vk::Result::TIMEOUT | vk::Result::NOT_READY) => return Ok(false),
            Err(e) => return Err(vk_error("acquiring an image")(e)),
        };
        let target = Target {
            image: swapchain.images[index],
            view: swapchain.views[index],
            extent: swapchain.extent,
            layout: vk::ImageLayout::PRESENT_SRC_KHR,
            copy: self
                .snapshot
                .as_ref()
                .and(self.snapshot_buffer.as_ref())
                .map(|b| b.buffer),
        };
        let rendered = swapchain.rendered[index];
        let swapchain_handle = swapchain.swapchain;
        let frame = &mut self.frames[f];
        unsafe {
            self.gpu
                .record(&frame.commands, &mut frame.buffers, list, &target)?;
            self.gpu
                .submit(&frame.commands, Some(frame.acquired), Some(rendered))?;
        }
        let swapchains = [swapchain_handle];
        let indices = [index as u32];
        let waits = [rendered];
        let rects: Vec<vk::RectLayerKHR> = damage
            .filter(|_| self.gpu.incremental_present && !self.fresh)
            .map(|damage| damage_rects(damage, target.extent))
            .unwrap_or_default();
        let regions = [vk::PresentRegionKHR::default().rectangles(&rects)];
        let mut present_regions = vk::PresentRegionsKHR::default().regions(&regions);
        let mut info = vk::PresentInfoKHR::default()
            .wait_semaphores(&waits)
            .swapchains(&swapchains)
            .image_indices(&indices);
        // With no rectangles, the whole image changed.
        if !rects.is_empty() {
            info = info.push_next(&mut present_regions);
        }
        self.fresh = false;
        match unsafe { self.swapchain_fn.queue_present(self.gpu.queue, &info) } {
            Ok(suboptimal) => self.stale |= suboptimal,
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => self.stale = true,
            Err(e) => return Err(vk_error("presenting")(e)),
        }
        if self.snapshot.is_some() {
            unsafe { self.write_snapshot(f, target.extent) }?;
        }
        self.frame = (f + 1) % FRAMES_IN_FLIGHT;
        Ok(true)
    }

    /// Writes the frame just submitted from frame slot `f` to the snapshot
    /// file, once the GPU is done with it; and makes sure the next frame
    /// has a buffer of `extent`'s size to copy into.
    unsafe fn write_snapshot(&mut self, f: usize, extent: vk::Extent2D) -> Result<(), String> {
        let bytes = extent.width as usize * extent.height as usize * 4;
        if let Some(buffer) = &self.snapshot_buffer {
            unsafe { self.gpu.wait(&self.frames[f].commands) }?;
            if buffer.capacity >= bytes {
                let pixels = unsafe { std::slice::from_raw_parts(buffer.mapped, bytes) };
                let bgra = matches!(
                    self.surface_format.format,
                    vk::Format::B8G8R8A8_UNORM | vk::Format::B8G8R8A8_SRGB
                );
                let path = self.snapshot.as_ref().expect("checked by the caller");
                write_ppm(path, extent, pixels, bgra)?;
            }
        }
        if self
            .snapshot_buffer
            .as_ref()
            .is_none_or(|b| b.capacity < bytes)
        {
            if let Some(old) = self.snapshot_buffer.take() {
                unsafe { self.gpu.device.device_wait_idle() }
                    .map_err(vk_error("waiting for the device"))?;
                unsafe { destroy_buffer(&self.gpu.device, old) };
            }
            self.snapshot_buffer =
                Some(unsafe { host_buffer(&self.gpu.device, &self.gpu.memory, bytes, true) }?);
            // The frame that has not been copied yet is drawn again.
            self.stale = true;
        }
        Ok(())
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe {
            let _ = self.gpu.device.device_wait_idle();
            for frame in std::mem::take(&mut self.frames) {
                self.gpu.destroy_buffers(frame.buffers);
                self.gpu.destroy_commands(frame.commands);
                self.gpu.device.destroy_semaphore(frame.acquired, None);
            }
            if let Some(swapchain) = self.swapchain.take() {
                self.destroy_swapchain(swapchain);
            }
            if let Some(buffer) = self.snapshot_buffer.take() {
                destroy_buffer(&self.gpu.device, buffer);
            }
            // Before the instance, which `gpu` destroys as it drops.
            self.surface_fn.destroy_surface(self.surface, None);
        }
    }
}

/// The surface's format: sRGB, so that frames blend in linear light, else
/// UNORM, which takes sRGB colors as they are (see kernel/gui.slang).
unsafe fn surface_format(
    surface_fn: &ash::khr::surface::Instance,
    physical: vk::PhysicalDevice,
    surface: vk::SurfaceKHR,
) -> Result<vk::SurfaceFormatKHR, String> {
    let formats = unsafe { surface_fn.get_physical_device_surface_formats(physical, surface) }
        .map_err(vk_error("listing surface formats"))?;
    formats
        .iter()
        .copied()
        .find(|f| is_srgb(f.format) && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR)
        .or_else(|| {
            formats.iter().copied().find(|f| {
                matches!(
                    f.format,
                    vk::Format::B8G8R8A8_UNORM | vk::Format::R8G8B8A8_UNORM
                ) && f.color_space == vk::ColorSpaceKHR::SRGB_NONLINEAR
            })
        })
        .or_else(|| formats.first().copied())
        .ok_or_else(|| "the surface has no formats".to_string())
}

// MARK: Made ahead

/// The device being made ahead ([`prepare`]): for windows on a display
/// whose surfaces this extension makes.
static PREPARED: Mutex<Option<(&'static CStr, JoinHandle<Result<Gpu, String>>)>> = Mutex::new(None);

/// The format a device is made ahead to draw in: what NVIDIA's driver
/// offers windows first. Pipelines are made again for another (Mesa's
/// drivers offer B8G8R8A8 first), which takes a millisecond.
const PREPARED_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// Starts making the device the first window will draw with, on another
/// thread, unless one is made or being made: for the display the
/// environment names (Wayland's, else X11's), as winit chooses it.
pub fn prepare() {
    let nonempty = |v: &str| std::env::var_os(v).is_some_and(|s| !s.is_empty());
    let x11 = std::env::var_os("QUAD_GUI_X11").is_some_and(|v| v == "1");
    let surface_extension = if nonempty("WAYLAND_DISPLAY") && !x11 {
        ash::khr::wayland_surface::NAME
    } else if nonempty("DISPLAY") {
        ash::khr::xlib_surface::NAME
    } else {
        return;
    };
    let mut prepared = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
    if prepared.is_some() {
        return;
    }
    let made = std::thread::Builder::new()
        .name("quad-gpu".into())
        .spawn(move || {
            let (entry, instance) = instance(&[ash::khr::surface::NAME, surface_extension])?;
            let picked = unsafe { pick_device(&instance, None) };
            let made = picked.and_then(|(physical, family)| {
                unsafe {
                    Gpu::new(
                        entry,
                        instance.clone(),
                        physical,
                        family,
                        PREPARED_FORMAT,
                        true,
                    )
                }
                .map_err(|(_, error)| error)
            });
            if made.is_err() {
                unsafe { instance.destroy_instance(None) };
            }
            made
        });
    if let Ok(handle) = made {
        *prepared = Some((surface_extension, handle));
    }
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

/// The device made ahead, waited for, if it suits the window with these
/// handles: made for its kind of display, able to draw to it, and made to
/// draw in its format (or made so again).
unsafe fn take_prepared(
    surface_extension: &CStr,
    display: RawDisplayHandle,
    handle: RawWindowHandle,
) -> Option<Gpu> {
    let (made_for, made) = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    let mut gpu = made.join().ok()?.ok()?;
    if made_for != surface_extension {
        return None;
    }
    let surface_fn = ash::khr::surface::Instance::new(&gpu.entry, &gpu.instance);
    let surface = unsafe { create_surface(&gpu.entry, &gpu.instance, display, handle) }.ok()?;
    let usable = unsafe {
        surface_fn.get_physical_device_surface_support(gpu.physical, gpu.family, surface)
    }
    .unwrap_or(false);
    let format = usable
        .then(|| unsafe { surface_format(&surface_fn, gpu.physical, surface) }.ok())
        .flatten();
    unsafe { surface_fn.destroy_surface(surface, None) };
    let format = format?.format;
    if format != gpu.format {
        timing::mark("the window draws in another format");
        unsafe { gpu.set_format(format) }.ok()?;
    }
    Some(gpu)
}

// MARK: Without a window

/// An image to draw into, on the device.
struct Image {
    image: vk::Image,
    memory: vk::DeviceMemory,
    view: vk::ImageView,
    extent: vk::Extent2D,
}

/// Draws frames into an image, with no window: for tests, and snapshots.
pub struct Headless {
    commands: Commands,
    buffers: Buffers,
    image: Option<Image>,
    readback: Option<HostBuffer>,
    // Last, so that it is dropped last.
    gpu: Gpu,
}

impl Headless {
    pub fn new() -> Result<Headless, String> {
        let (entry, instance) = instance(&[])?;
        let (physical, family) = match unsafe { pick_device(&instance, None) } {
            Ok(picked) => picked,
            Err(error) => {
                unsafe { instance.destroy_instance(None) };
                return Err(error);
            }
        };
        let gpu = unsafe { Gpu::new(entry, instance, physical, family, HEADLESS_FORMAT, false) }
            .map_err(|(instance, error)| {
                unsafe { instance.destroy_instance(None) };
                error
            })?;
        let commands = unsafe { gpu.commands() }?;
        Ok(Headless {
            commands,
            buffers: Buffers::default(),
            image: None,
            readback: None,
            gpu,
        })
    }

    /// The device drawing, by name.
    pub fn device_name(&self) -> String {
        let props = unsafe {
            self.gpu
                .instance
                .get_physical_device_properties(self.gpu.physical)
        };
        unsafe { CStr::from_ptr(props.device_name.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    /// Draws a frame `width` by `height` pixels; returns its pixels, RGBA,
    /// top row first.
    pub fn draw(&mut self, list: &DrawList, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let extent = vk::Extent2D {
            width: width.max(1),
            height: height.max(1),
        };
        let bytes = extent.width as usize * extent.height as usize * 4;
        unsafe {
            if self.image.as_ref().is_none_or(|i| i.extent != extent) {
                if let Some(old) = self.image.take() {
                    self.destroy_image(old);
                }
                self.image = Some(self.create_image(extent)?);
            }
            if self.readback.as_ref().is_none_or(|b| b.capacity < bytes) {
                if let Some(old) = self.readback.take() {
                    destroy_buffer(&self.gpu.device, old);
                }
                self.readback = Some(host_buffer(
                    &self.gpu.device,
                    &self.gpu.memory,
                    bytes,
                    true,
                )?);
            }
            let image = self.image.as_ref().expect("made above");
            let readback = self.readback.as_ref().expect("made above");
            let target = Target {
                image: image.image,
                view: image.view,
                extent,
                layout: vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                copy: Some(readback.buffer),
            };
            self.gpu.wait(&self.commands)?;
            self.gpu
                .record(&self.commands, &mut self.buffers, list, &target)?;
            self.gpu.submit(&self.commands, None, None)?;
            self.gpu.wait(&self.commands)?;
            Ok(std::slice::from_raw_parts(readback.mapped, bytes).to_vec())
        }
    }

    unsafe fn create_image(&self, extent: vk::Extent2D) -> Result<Image, String> {
        let d = &self.gpu.device;
        let image = unsafe {
            d.create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(HEADLESS_FORMAT)
                    .extent(vk::Extent3D {
                        width: extent.width,
                        height: extent.height,
                        depth: 1,
                    })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(
                        vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
        }
        .map_err(vk_error("creating an image"))?;
        let needs = unsafe { d.get_image_memory_requirements(image) };
        let memory = match memory_type(
            &self.gpu.memory,
            needs.memory_type_bits,
            vk::MemoryPropertyFlags::DEVICE_LOCAL,
        )
        .or_else(|| {
            memory_type(
                &self.gpu.memory,
                needs.memory_type_bits,
                vk::MemoryPropertyFlags::empty(),
            )
        })
        .ok_or_else(|| "vulkan: no memory for an image".to_string())
        .and_then(|kind| {
            unsafe {
                d.allocate_memory(
                    &vk::MemoryAllocateInfo::default()
                        .allocation_size(needs.size)
                        .memory_type_index(kind),
                    None,
                )
            }
            .map_err(vk_error("allocating memory"))
        }) {
            Ok(memory) => memory,
            Err(error) => {
                unsafe { d.destroy_image(image, None) };
                return Err(error);
            }
        };
        let view = unsafe { d.bind_image_memory(image, memory, 0) }
            .map_err(vk_error("binding memory"))
            .and_then(|()| unsafe { image_view(d, image, HEADLESS_FORMAT) });
        match view {
            Ok(view) => Ok(Image {
                image,
                memory,
                view,
                extent,
            }),
            Err(error) => {
                unsafe {
                    d.destroy_image(image, None);
                    d.free_memory(memory, None);
                }
                Err(error)
            }
        }
    }

    unsafe fn destroy_image(&self, i: Image) {
        let d = &self.gpu.device;
        unsafe {
            let _ = d.device_wait_idle();
            d.destroy_image_view(i.view, None);
            d.destroy_image(i.image, None);
            d.free_memory(i.memory, None);
        }
    }
}

impl Drop for Headless {
    fn drop(&mut self) {
        unsafe {
            let _ = self.gpu.device.device_wait_idle();
            if let Some(image) = self.image.take() {
                self.destroy_image(image);
            }
            if let Some(buffer) = self.readback.take() {
                destroy_buffer(&self.gpu.device, buffer);
            }
            self.gpu.destroy_buffers(std::mem::take(&mut self.buffers));
            let commands = std::mem::replace(
                &mut self.commands,
                Commands {
                    pool: vk::CommandPool::null(),
                    buffer: vk::CommandBuffer::null(),
                    done: vk::Fence::null(),
                },
            );
            self.gpu.destroy_commands(commands);
        }
    }
}

// MARK: Helpers

/// Writes RGBA (or BGRA) pixels as a PPM image.
pub fn write_ppm(
    path: &std::path::Path,
    extent: vk::Extent2D,
    pixels: &[u8],
    bgra: bool,
) -> Result<(), String> {
    let mut ppm = format!("P6\n{} {}\n255\n", extent.width, extent.height).into_bytes();
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

/// The name of a SPIR-V module's first entry point.
fn entry_point_name(code: &[u8]) -> Option<std::ffi::CString> {
    let words: Vec<u32> = code
        .chunks_exact(4)
        .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    // After the five-word header, instructions: a word of length (high 16
    // bits) and opcode (low), then operands. OpEntryPoint (15) is the
    // execution model, the function, then the name as a nul-terminated
    // string packed into words.
    let mut i = 5;
    while i < words.len() {
        let (length, opcode) = ((words[i] >> 16) as usize, words[i] & 0xffff);
        if length == 0 {
            return None;
        }
        if opcode == 15 {
            let bytes: Vec<u8> = words
                .get(i + 3..i + length)?
                .iter()
                .flat_map(|w| w.to_le_bytes())
                .collect();
            let end = bytes.iter().position(|&b| b == 0)?;
            return std::ffi::CString::new(&bytes[..end]).ok();
        }
        i += length;
    }
    None
}

fn memory_type(
    memory: &vk::PhysicalDeviceMemoryProperties,
    bits: u32,
    wanted: vk::MemoryPropertyFlags,
) -> Option<u32> {
    (0..memory.memory_type_count).find(|&i| {
        bits & (1 << i) != 0
            && memory.memory_types[i as usize]
                .property_flags
                .contains(wanted)
    })
}

/// Copies `bytes` into `slot`'s buffer, first making it larger if they do
/// not fit; returns the buffer's address. The GPU must be done with it.
unsafe fn write(
    device: &ash::Device,
    memory: &vk::PhysicalDeviceMemoryProperties,
    slot: &mut Option<HostBuffer>,
    bytes: &[u8],
) -> Result<vk::DeviceAddress, String> {
    if slot.as_ref().is_none_or(|b| b.capacity < bytes.len()) {
        if let Some(old) = slot.take() {
            unsafe { destroy_buffer(device, old) };
        }
        *slot = Some(unsafe { host_buffer(device, memory, bytes.len(), false) }?);
    }
    let buffer = slot.as_ref().expect("made above");
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), buffer.mapped, bytes.len()) };
    Ok(buffer.address)
}

/// A buffer of at least `bytes`, mapped, addressable by the GPU, and a
/// place to copy images to; `read` if the CPU reads it.
unsafe fn host_buffer(
    device: &ash::Device,
    memory: &vk::PhysicalDeviceMemoryProperties,
    bytes: usize,
    read: bool,
) -> Result<HostBuffer, String> {
    let capacity = bytes.max(4096).next_power_of_two();
    let buffer = unsafe {
        device.create_buffer(
            &vk::BufferCreateInfo::default()
                .size(capacity as u64)
                .usage(
                    vk::BufferUsageFlags::STORAGE_BUFFER
                        | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS
                        | vk::BufferUsageFlags::TRANSFER_DST,
                )
                .sharing_mode(vk::SharingMode::EXCLUSIVE),
            None,
        )
    }
    .map_err(vk_error("creating a buffer"))?;
    let needs = unsafe { device.get_buffer_memory_requirements(buffer) };
    let coherent = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
    // Memory the CPU reads back (images copied to it) is cached where it
    // can be: uncached memory, which suits what the CPU only writes, reads
    // slowly.
    let kind = if read {
        memory_type(
            memory,
            needs.memory_type_bits,
            coherent | vk::MemoryPropertyFlags::HOST_CACHED,
        )
    } else {
        None
    }
    .or_else(|| memory_type(memory, needs.memory_type_bits, coherent));
    let Some(kind) = kind else {
        unsafe { device.destroy_buffer(buffer, None) };
        return Err("vulkan: no host-visible memory for a buffer".into());
    };
    let mut flags =
        vk::MemoryAllocateFlagsInfo::default().flags(vk::MemoryAllocateFlags::DEVICE_ADDRESS);
    let allocated = match unsafe {
        device.allocate_memory(
            &vk::MemoryAllocateInfo::default()
                .allocation_size(needs.size)
                .memory_type_index(kind)
                .push_next(&mut flags),
            None,
        )
    } {
        Ok(memory) => memory,
        Err(e) => {
            unsafe { device.destroy_buffer(buffer, None) };
            return Err(vk_error("allocating memory")(e));
        }
    };
    let made = unsafe {
        device
            .bind_buffer_memory(buffer, allocated, 0)
            .and_then(|()| device.map_memory(allocated, 0, needs.size, vk::MemoryMapFlags::empty()))
    };
    match made {
        Ok(mapped) => {
            let address = unsafe {
                device.get_buffer_device_address(
                    &vk::BufferDeviceAddressInfo::default().buffer(buffer),
                )
            };
            Ok(HostBuffer {
                buffer,
                memory: allocated,
                mapped: mapped.cast(),
                capacity,
                address,
            })
        }
        Err(e) => {
            unsafe {
                device.destroy_buffer(buffer, None);
                device.free_memory(allocated, None);
            }
            Err(vk_error("mapping memory")(e))
        }
    }
}

unsafe fn destroy_buffer(device: &ash::Device, b: HostBuffer) {
    unsafe {
        device.destroy_buffer(b.buffer, None);
        device.free_memory(b.memory, None);
    }
}

unsafe fn image_view(
    d: &ash::Device,
    image: vk::Image,
    format: vk::Format,
) -> Result<vk::ImageView, String> {
    unsafe {
        d.create_image_view(
            &vk::ImageViewCreateInfo::default()
                .image(image)
                .view_type(vk::ImageViewType::TYPE_2D)
                .format(format)
                .subresource_range(COLOR_RANGE),
            None,
        )
    }
    .map_err(vk_error("creating an image view"))
}

const COLOR_RANGE: vk::ImageSubresourceRange = vk::ImageSubresourceRange {
    aspect_mask: vk::ImageAspectFlags::COLOR,
    base_mip_level: 0,
    level_count: 1,
    base_array_layer: 0,
    layer_count: 1,
};

unsafe fn barrier(
    d: &ash::Device,
    commands: vk::CommandBuffer,
    image: vk::Image,
    (old, new): (vk::ImageLayout, vk::ImageLayout),
    (src, dst): (vk::AccessFlags2, vk::AccessFlags2),
) {
    // Color output, and copies of the image.
    let stages = vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT | vk::PipelineStageFlags2::COPY;
    let barriers = [vk::ImageMemoryBarrier2::default()
        .src_stage_mask(stages)
        .src_access_mask(src)
        .dst_stage_mask(stages)
        .dst_access_mask(dst)
        .old_layout(old)
        .new_layout(new)
        .image(image)
        .subresource_range(COLOR_RANGE)];
    unsafe {
        d.cmd_pipeline_barrier2(
            commands,
            &vk::DependencyInfo::default().image_memory_barriers(&barriers),
        )
    };
}

unsafe fn create_surface(
    entry: &ash::Entry,
    instance: &ash::Instance,
    display: RawDisplayHandle,
    window: RawWindowHandle,
) -> Result<vk::SurfaceKHR, String> {
    let made = match (display, window) {
        (RawDisplayHandle::Wayland(d), RawWindowHandle::Wayland(w)) => unsafe {
            ash::khr::wayland_surface::Instance::new(entry, instance).create_wayland_surface(
                &vk::WaylandSurfaceCreateInfoKHR::default()
                    .display(d.display.as_ptr().cast())
                    .surface(w.surface.as_ptr().cast()),
                None,
            )
        },
        (RawDisplayHandle::Xlib(d), RawWindowHandle::Xlib(w)) => {
            let dpy = d.display.ok_or("X11: no display")?;
            unsafe {
                ash::khr::xlib_surface::Instance::new(entry, instance).create_xlib_surface(
                    &vk::XlibSurfaceCreateInfoKHR::default()
                        .dpy(dpy.as_ptr().cast())
                        .window(w.window),
                    None,
                )
            }
        }
        _ => return Err("only Wayland and X11 (Xlib) windows are supported".into()),
    };
    made.map_err(vk_error("creating a surface"))
}

/// A device with Vulkan 1.3 and buffer device addresses (both core there)
/// that can draw (and present to `surface`, if there is one), and its
/// queue family: the one `QUAD_GUI_DEVICE` names, else a discrete GPU
/// first, then an integrated one, then any.
unsafe fn pick_device(
    instance: &ash::Instance,
    surface: Option<(&ash::khr::surface::Instance, vk::SurfaceKHR)>,
) -> Result<(vk::PhysicalDevice, u32), String> {
    let wanted = std::env::var("QUAD_GUI_DEVICE")
        .ok()
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase());
    let devices =
        unsafe { instance.enumerate_physical_devices() }.map_err(vk_error("listing devices"))?;
    let mut best: Option<(u32, vk::PhysicalDevice, u32)> = None;
    let mut seen = Vec::new();
    for device in devices {
        let props = unsafe { instance.get_physical_device_properties(device) };
        let name = unsafe { CStr::from_ptr(props.device_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        let named = wanted
            .as_ref()
            .is_none_or(|w| name.to_lowercase().contains(w));
        seen.push(name);
        if props.api_version < vk::API_VERSION_1_3 || !named {
            continue;
        }
        let families = unsafe { instance.get_physical_device_queue_family_properties(device) };
        let family = families.iter().enumerate().find_map(|(i, f)| {
            let i = i as u32;
            let presents = surface.is_none_or(|(surface_fn, surface)| {
                unsafe { surface_fn.get_physical_device_surface_support(device, i, surface) }
                    .unwrap_or(false)
            });
            (f.queue_flags.contains(vk::QueueFlags::GRAPHICS) && presents).then_some(i)
        });
        let Some(family) = family else { continue };
        let rank = match props.device_type {
            vk::PhysicalDeviceType::DISCRETE_GPU => 3,
            vk::PhysicalDeviceType::INTEGRATED_GPU => 2,
            vk::PhysicalDeviceType::VIRTUAL_GPU => 1,
            _ => 0,
        };
        if best.is_none_or(|(r, _, _)| rank > r) {
            best = Some((rank, device, family));
        }
    }
    best.map(|(_, device, family)| (device, family))
        .ok_or_else(|| {
            format!(
                "no Vulkan 1.3 device {}can draw{} (devices: {})",
                wanted.map_or(String::new(), |w| format!("named like {w:?} ")),
                if surface.is_some() {
                    " to this window"
                } else {
                    ""
                },
                if seen.is_empty() {
                    "none".into()
                } else {
                    seen.join(", ")
                }
            )
        })
}

/// `damage` (rectangles in pixels: x, y, width, height) within an image of
/// `extent`, as presenting takes it.
fn damage_rects(damage: &[[u32; 4]], extent: vk::Extent2D) -> Vec<vk::RectLayerKHR> {
    damage
        .iter()
        .filter_map(|&[x, y, w, h]| {
            let (x, y) = (x.min(extent.width), y.min(extent.height));
            let w = w.min(extent.width - x);
            let h = h.min(extent.height - y);
            (w > 0 && h > 0).then_some(vk::RectLayerKHR {
                offset: vk::Offset2D {
                    x: x as i32,
                    y: y as i32,
                },
                extent: vk::Extent2D {
                    width: w,
                    height: h,
                },
                layer: 0,
            })
        })
        .collect()
}

/// Makes the device, with a swapchain if `swapchain`; returns it, and
/// whether it can present only what changed (VK_KHR_incremental_present).
unsafe fn create_device(
    instance: &ash::Instance,
    physical: vk::PhysicalDevice,
    family: u32,
    swapchain: bool,
) -> Result<(ash::Device, bool), String> {
    let priorities = [1.0];
    let queues = [vk::DeviceQueueCreateInfo::default()
        .queue_family_index(family)
        .queue_priorities(&priorities)];
    let incremental = swapchain
        && unsafe { instance.enumerate_device_extension_properties(physical) }
            .unwrap_or_default()
            .iter()
            .any(|e| e.extension_name_as_c_str() == Ok(ash::khr::incremental_present::NAME));
    let mut extensions: Vec<*const c_char> = Vec::new();
    if swapchain {
        extensions.push(ash::khr::swapchain::NAME.as_ptr());
    }
    if incremental {
        extensions.push(ash::khr::incremental_present::NAME.as_ptr());
    }
    let mut v12 = vk::PhysicalDeviceVulkan12Features::default().buffer_device_address(true);
    let mut v13 = vk::PhysicalDeviceVulkan13Features::default()
        .dynamic_rendering(true)
        .synchronization2(true);
    unsafe {
        instance.create_device(
            physical,
            &vk::DeviceCreateInfo::default()
                .queue_create_infos(&queues)
                .enabled_extension_names(&extensions)
                .push_next(&mut v12)
                .push_next(&mut v13),
            None,
        )
    }
    .map(|device| (device, incremental))
    .map_err(vk_error("creating the device"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damage_is_kept_within_the_image() {
        let extent = vk::Extent2D {
            width: 100,
            height: 50,
        };
        let rects = damage_rects(&[[10, 40, 200, 20], [0, 60, 10, 10], [5, 5, 0, 3]], extent);
        assert_eq!(rects.len(), 1);
        assert_eq!((rects[0].offset.x, rects[0].offset.y), (10, 40));
        assert_eq!((rects[0].extent.width, rects[0].extent.height), (90, 10));
    }

    #[test]
    fn the_shaders_entry_points_are_named_for_their_pipelines() {
        let name = |code: &[u8]| entry_point_name(code).map(|n| n.into_string().unwrap());
        assert_eq!(name(RECT_VERTEX).as_deref(), Some("rectVertex"));
        assert_eq!(name(RECT_FRAGMENT).as_deref(), Some("rectFragment"));
        assert_eq!(name(GLYPH_VERTEX).as_deref(), Some("glyphVertex"));
        assert_eq!(name(GLYPH_FRAGMENT).as_deref(), Some("glyphFragment"));
        assert_eq!(name(IMAGE_VERTEX).as_deref(), Some("imageVertex"));
        assert_eq!(name(IMAGE_FRAGMENT).as_deref(), Some("imageFragment"));
    }
}
