// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The device: Vulkan loaded, a device picked and made, its pipelines,
//! and the buffers, commands and barriers drawing takes, with a window or
//! without.

use super::*;

// MARK: The device

/// A buffer the CPU writes and the GPU reads by address.
pub(super) struct HostBuffer {
    pub(super) buffer: vk::Buffer,
    pub(super) memory: vk::DeviceMemory,
    pub(super) mapped: *mut u8,
    pub(super) capacity: usize,
    pub(super) address: vk::DeviceAddress,
}

/// A frame's data on the GPU, refilled each time it is drawn.
#[derive(Default)]
pub(super) struct Buffers {
    pub(super) rects: Option<HostBuffer>,
    pub(super) glyphs: Option<HostBuffer>,
    pub(super) decorations: Option<HostBuffer>,
    pub(super) curves: Option<HostBuffer>,
    pub(super) bands: Option<HostBuffer>,
    /// The atlas generation `curves` and `bands` hold.
    pub(super) atlas: Option<u64>,
    pub(super) pictures: Option<HostBuffer>,
    pub(super) pixels: Option<HostBuffer>,
    /// The generation of the pixels `pixels` holds.
    pub(super) pixels_generation: Option<u64>,
}

/// A frame's commands, and the fence that says the GPU is done with them.
pub(super) struct Commands {
    pub(super) pool: vk::CommandPool,
    pub(super) buffer: vk::CommandBuffer,
    pub(super) done: vk::Fence,
}

/// Where a frame is drawn: an image, left in `layout` afterwards, and
/// copied to `copy` first if there is one.
pub(super) struct Target {
    pub(super) image: vk::Image,
    pub(super) view: vk::ImageView,
    pub(super) extent: vk::Extent2D,
    pub(super) layout: vk::ImageLayout,
    pub(super) copy: Option<vk::Buffer>,
}

/// Vulkan, a device and its pipelines: what drawing needs, with a window
/// or without one. Dropping it destroys the device and the instance.
pub struct Gpu {
    // Kept for the library ash loaded: everything else calls into it.
    pub(super) entry: ash::Entry,
    pub(super) instance: ash::Instance,
    pub(super) physical: vk::PhysicalDevice,
    pub(super) memory: vk::PhysicalDeviceMemoryProperties,
    pub(super) device: ash::Device,
    pub(super) queue: vk::Queue,
    pub(super) family: u32,
    pub(super) format: vk::Format,
    pub(super) layout: vk::PipelineLayout,
    pub(super) rect_pipeline: vk::Pipeline,
    pub(super) glyph_pipeline: vk::Pipeline,
    pub(super) image_pipeline: vk::Pipeline,
    /// Whether presenting can say what changed (VK_KHR_incremental_present).
    pub(super) incremental_present: bool,
}

/// Loads Vulkan and makes an instance with `extensions`.
pub(super) fn instance(extensions: &[&CStr]) -> Result<(ash::Entry, ash::Instance), String> {
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
    pub(super) unsafe fn new(
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
    pub(super) unsafe fn set_format(&mut self, format: vk::Format) -> Result<(), String> {
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

    pub(super) unsafe fn pipelines(&mut self) -> Result<(), String> {
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
    pub(super) unsafe fn create_pipeline(
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

    pub(super) unsafe fn commands(&self) -> Result<Commands, String> {
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

    pub(super) unsafe fn destroy_commands(&self, c: Commands) {
        unsafe {
            self.device.destroy_fence(c.done, None);
            self.device.destroy_command_pool(c.pool, None);
        }
    }

    pub(super) unsafe fn destroy_buffers(&self, b: Buffers) {
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

    pub(super) unsafe fn wait(&self, c: &Commands) -> Result<(), String> {
        unsafe { self.device.wait_for_fences(&[c.done], true, u64::MAX) }
            .map_err(vk_error("waiting for a frame"))
    }

    /// Fills `buffers` with `list`'s data and records drawing it into
    /// `target`. The GPU must be done with `buffers` and `commands`.
    pub(super) unsafe fn record(
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
    pub(super) unsafe fn submit(
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

    pub(super) unsafe fn destroy_device(&mut self) {
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

/// The name of a SPIR-V module's first entry point.
pub(super) fn entry_point_name(code: &[u8]) -> Option<std::ffi::CString> {
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

pub(super) fn memory_type(
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
pub(super) unsafe fn write(
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
pub(super) unsafe fn host_buffer(
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

pub(super) unsafe fn destroy_buffer(device: &ash::Device, b: HostBuffer) {
    unsafe {
        device.destroy_buffer(b.buffer, None);
        device.free_memory(b.memory, None);
    }
}

pub(super) unsafe fn image_view(
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

pub(super) const COLOR_RANGE: vk::ImageSubresourceRange = vk::ImageSubresourceRange {
    aspect_mask: vk::ImageAspectFlags::COLOR,
    base_mip_level: 0,
    level_count: 1,
    base_array_layer: 0,
    layer_count: 1,
};

pub(super) unsafe fn barrier(
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

/// A device with Vulkan 1.3 and buffer device addresses (both core there)
/// that can draw (and present to `surface`, if there is one), and its
/// queue family: the one `QUAD_GUI_DEVICE` names, else a discrete GPU
/// first, then an integrated one, then any.
pub(super) unsafe fn pick_device(
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

/// Makes the device, with a swapchain if `swapchain`; returns it, and
/// whether it can present only what changed (VK_KHR_incremental_present).
pub(super) unsafe fn create_device(
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
