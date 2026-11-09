// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Vulkan's objects, owned: the one place the renderer calls Vulkan, and so
//! the one place it is `unsafe`. Everything outside this module is safe
//! code over these types.
//!
//! Each object holds what it was made from (its [`Instance`], its
//! [`Device`], its [`Surface`]) by `Arc`, so none can outlive it, and is
//! destroyed when dropped; what the GPU may still be using waits for the
//! device to be idle first. A [`Physical`] device is its instance's, and
//! is checked against the objects it is used with. Memory the CPU maps
//! ([`HostBuffer`]) is written only by a [`Frame`] whose earlier commands
//! are done (its fence waited for), and read only once the device is idle,
//! while nothing can submit commands copying into it (reading borrows it,
//! and copying into it takes it mutably). Handles recorded into commands
//! come from objects this module made ([`Target`]s are made only here).
//! With those, each call's validity follows from the types, which is what
//! each `SAFETY` note says.

use std::ffi::{CStr, c_char};
use std::ptr::NonNull;
use std::sync::Arc;

use ash::vk;
use winit::raw_window_handle::{
    HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use winit::window::Window;

use super::{
    DrawList, GLYPH_BYTES, GLYPH_FRAGMENT, GLYPH_VERTEX, IMAGE_FRAGMENT, IMAGE_VERTEX,
    PICTURE_BYTES, RECT_BYTES, RECT_FRAGMENT, RECT_VERTEX, entry_point_name, is_srgb, linearize,
    vk_error,
};
use crate::timing;

// MARK: The instance and devices

/// Vulkan, loaded, and an instance of it.
pub(super) struct Instance {
    entry: ash::Entry,
    raw: ash::Instance,
}

impl Instance {
    /// Loads Vulkan (the host's `libvulkan.so.1`) and makes an instance
    /// with `extensions`.
    pub(super) fn load(extensions: &[&CStr]) -> Result<Arc<Instance>, String> {
        // SAFETY: loading the Vulkan loader runs its initializers, as it is
        // meant to; the library stays loaded while `entry` lives, which is
        // as long as the instance does.
        let entry = unsafe { ash::Entry::load() }.map_err(|e| {
            format!(
                "cannot load Vulkan (libvulkan.so.1): {e}; is this the host-linked quad (:quad)?"
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
        let info = vk::InstanceCreateInfo::default()
            .application_info(&app)
            .enabled_extension_names(&extensions)
            .enabled_layer_names(&layers);
        // SAFETY: the create info and the names it points at live through
        // the call.
        let raw = unsafe { entry.create_instance(&info, None) }
            .map_err(vk_error("creating an instance"))?;
        timing::mark("vulkan loaded");
        Ok(Arc::new(Instance { entry, raw }))
    }

    /// Its devices.
    pub(super) fn physical_devices(self: &Arc<Self>) -> Result<Vec<Physical>, String> {
        // SAFETY: a live instance.
        let raws = unsafe { self.raw.enumerate_physical_devices() }
            .map_err(vk_error("listing devices"))?;
        Ok(raws
            .into_iter()
            .map(|raw| Physical {
                instance: self.clone(),
                raw,
            })
            .collect())
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // SAFETY: everything made from the instance holds it, so is gone.
        unsafe { self.raw.destroy_instance(None) };
    }
}

/// A device of an instance, which it holds.
#[derive(Clone)]
pub(super) struct Physical {
    instance: Arc<Instance>,
    raw: vk::PhysicalDevice,
}

impl Physical {
    pub(super) fn instance(&self) -> &Arc<Instance> {
        &self.instance
    }

    pub(super) fn properties(&self) -> vk::PhysicalDeviceProperties {
        // SAFETY: a device its instance listed, and the instance is live.
        unsafe { self.instance.raw.get_physical_device_properties(self.raw) }
    }

    pub(super) fn name(&self) -> String {
        self.properties().device_name_as_c_str().map_or_else(
            |_| "an unnamed device".into(),
            |n| n.to_string_lossy().into_owned(),
        )
    }

    pub(super) fn queue_families(&self) -> Vec<vk::QueueFamilyProperties> {
        // SAFETY: as for properties.
        unsafe {
            self.instance
                .raw
                .get_physical_device_queue_family_properties(self.raw)
        }
    }

    fn memory(&self) -> vk::PhysicalDeviceMemoryProperties {
        // SAFETY: as for properties.
        unsafe {
            self.instance
                .raw
                .get_physical_device_memory_properties(self.raw)
        }
    }

    fn has_extension(&self, name: &CStr) -> bool {
        // SAFETY: as for properties.
        unsafe {
            self.instance
                .raw
                .enumerate_device_extension_properties(self.raw)
        }
        .unwrap_or_default()
        .iter()
        .any(|e| e.extension_name_as_c_str() == Ok(name))
    }
}

/// A device made, with its queue: what everything drawn is made on.
pub(super) struct Device {
    physical: Physical,
    raw: ash::Device,
    family: u32,
    queue: vk::Queue,
    memory: vk::PhysicalDeviceMemoryProperties,
    /// Whether presenting can say what changed (VK_KHR_incremental_present).
    pub(super) incremental_present: bool,
}

impl Device {
    /// Makes `physical` a device, with Vulkan 1.3's dynamic rendering and
    /// synchronization2 and buffer device addresses, drawing on queue
    /// family `family`; with a swapchain if `swapchain`.
    pub(super) fn new(
        physical: Physical,
        family: u32,
        swapchain: bool,
    ) -> Result<Arc<Device>, String> {
        let priorities = [1.0];
        let queues = [vk::DeviceQueueCreateInfo::default()
            .queue_family_index(family)
            .queue_priorities(&priorities)];
        let incremental = swapchain && physical.has_extension(ash::khr::incremental_present::NAME);
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
        let info = vk::DeviceCreateInfo::default()
            .queue_create_infos(&queues)
            .enabled_extension_names(&extensions)
            .push_next(&mut v12)
            .push_next(&mut v13);
        // SAFETY: a device of the live instance, and a create info whose
        // pointers live through the call; then the device's own queue.
        let (raw, queue) = unsafe {
            let raw = physical
                .instance
                .raw
                .create_device(physical.raw, &info, None)
                .map_err(vk_error("creating the device"))?;
            let queue = raw.get_device_queue(family, 0);
            (raw, queue)
        };
        timing::mark("device made");
        let memory = physical.memory();
        Ok(Arc::new(Device {
            physical,
            raw,
            family,
            queue,
            memory,
            incremental_present: incremental,
        }))
    }

    pub(super) fn physical(&self) -> &Physical {
        &self.physical
    }

    pub(super) fn family(&self) -> u32 {
        self.family
    }

    /// Waits until the device has done everything it was given.
    pub(super) fn wait_idle(&self) -> Result<(), String> {
        // SAFETY: a live device.
        unsafe { self.raw.device_wait_idle() }.map_err(vk_error("waiting for the device"))
    }

    fn memory_type(&self, bits: u32, wanted: vk::MemoryPropertyFlags) -> Option<u32> {
        let m = &self.memory;
        (0..m.memory_type_count).find(|&i| {
            bits & (1 << i) != 0 && m.memory_types[i as usize].property_flags.contains(wanted)
        })
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        // SAFETY: everything made on the device holds it, so is gone; the
        // device finishes what it was given before it goes.
        unsafe {
            let _ = self.raw.device_wait_idle();
            self.raw.destroy_device(None);
        }
    }
}

// MARK: Pipelines

/// The three pipelines (kernel/gui.slang), drawing in `format`: four-vertex
/// strips, blending by alpha over what was drawn before, their data found
/// by address in their push constants ([`Params`]).
pub(super) struct Pipelines {
    device: Arc<Device>,
    pub(super) format: vk::Format,
    layout: vk::PipelineLayout,
    rect: vk::Pipeline,
    glyph: vk::Pipeline,
    image: vk::Pipeline,
}

/// A shader module, gone once a pipeline is made from it.
struct Module<'d> {
    device: &'d Device,
    raw: vk::ShaderModule,
    entry: std::ffi::CString,
}

impl<'d> Module<'d> {
    fn new(device: &'d Device, code: &[u8]) -> Result<Module<'d>, String> {
        let entry = entry_point_name(code).ok_or("a shader has no entry point")?;
        let words: Vec<u32> = code
            .chunks_exact(4)
            .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
            .collect();
        let info = vk::ShaderModuleCreateInfo::default().code(&words);
        // SAFETY: a live device, and SPIR-V slangc compiled.
        let raw = unsafe { device.raw.create_shader_module(&info, None) }
            .map_err(vk_error("creating a shader module"))?;
        Ok(Module { device, raw, entry })
    }
}

impl Drop for Module<'_> {
    fn drop(&mut self) {
        // SAFETY: pipelines keep nothing of the modules they were made from.
        unsafe { self.device.raw.destroy_shader_module(self.raw, None) };
    }
}

impl Pipelines {
    pub(super) fn new(device: &Arc<Device>, format: vk::Format) -> Result<Pipelines, String> {
        let push = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT)
            .size(Params::BYTES as u32)];
        let info = vk::PipelineLayoutCreateInfo::default().push_constant_ranges(&push);
        // SAFETY: a live device; the create info lives through the call.
        let layout = unsafe { device.raw.create_pipeline_layout(&info, None) }
            .map_err(vk_error("creating the pipeline layout"))?;
        // Null handles until made: destroying one is nothing.
        let mut pipelines = Pipelines {
            device: device.clone(),
            format,
            layout,
            rect: vk::Pipeline::null(),
            glyph: vk::Pipeline::null(),
            image: vk::Pipeline::null(),
        };
        pipelines.rect = pipelines.pipeline(RECT_VERTEX, RECT_FRAGMENT)?;
        pipelines.glyph = pipelines.pipeline(GLYPH_VERTEX, GLYPH_FRAGMENT)?;
        pipelines.image = pipelines.pipeline(IMAGE_VERTEX, IMAGE_FRAGMENT)?;
        timing::mark("pipelines made");
        Ok(pipelines)
    }

    fn pipeline(&self, vertex: &[u8], fragment: &[u8]) -> Result<vk::Pipeline, String> {
        let (vertex, fragment) = (
            Module::new(&self.device, vertex)?,
            Module::new(&self.device, fragment)?,
        );
        let stages = [
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::VERTEX)
                .module(vertex.raw)
                .name(&vertex.entry),
            vk::PipelineShaderStageCreateInfo::default()
                .stage(vk::ShaderStageFlags::FRAGMENT)
                .module(fragment.raw)
                .name(&fragment.entry),
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
        // SAFETY: a live device, its live layout and modules, and a create
        // info whose pointers live through the call.
        unsafe {
            self.device
                .raw
                .create_graphics_pipelines(vk::PipelineCache::null(), &[info], None)
        }
        .map(|p| p[0])
        .map_err(|(_, e)| vk_error("creating a pipeline")(e))
    }
}

impl Drop for Pipelines {
    fn drop(&mut self) {
        // SAFETY: commands drawn with them may still run: wait for them.
        // Destroying a null handle (one never made) does nothing.
        unsafe {
            let _ = self.device.raw.device_wait_idle();
            for p in [self.rect, self.glyph, self.image] {
                self.device.raw.destroy_pipeline(p, None);
            }
            self.device.raw.destroy_pipeline_layout(self.layout, None);
        }
    }
}

// MARK: Memory

/// A buffer the CPU writes (or reads) and the GPU reads (or writes) by
/// address: host-visible, coherent memory, mapped as long as it lives.
pub(super) struct HostBuffer {
    device: Arc<Device>,
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
    mapped: NonNull<u8>,
    capacity: usize,
    address: vk::DeviceAddress,
}

impl HostBuffer {
    /// A buffer of at least `bytes`; `read` if the CPU reads it back.
    pub(super) fn new(
        device: &Arc<Device>,
        bytes: usize,
        read: bool,
    ) -> Result<HostBuffer, String> {
        let capacity = bytes.max(4096).next_power_of_two();
        let d = &device.raw;
        let info = vk::BufferCreateInfo::default()
            .size(capacity as u64)
            .usage(
                vk::BufferUsageFlags::STORAGE_BUFFER
                    | vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS
                    | vk::BufferUsageFlags::TRANSFER_DST,
            )
            .sharing_mode(vk::SharingMode::EXCLUSIVE);
        // SAFETY: a live device; the buffer is destroyed again on every
        // failure below, and otherwise by Drop.
        let buffer =
            unsafe { d.create_buffer(&info, None) }.map_err(vk_error("creating a buffer"))?;
        // SAFETY: the buffer just made.
        let needs = unsafe { d.get_buffer_memory_requirements(buffer) };
        let coherent =
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        // Memory the CPU reads back is cached where it can be: uncached
        // memory, which suits what the CPU only writes, reads slowly.
        let kind = read
            .then(|| {
                device.memory_type(
                    needs.memory_type_bits,
                    coherent | vk::MemoryPropertyFlags::HOST_CACHED,
                )
            })
            .flatten()
            .or_else(|| device.memory_type(needs.memory_type_bits, coherent));
        let destroy = || {
            // SAFETY: the buffer is unused yet.
            unsafe { d.destroy_buffer(buffer, None) }
        };
        let Some(kind) = kind else {
            destroy();
            return Err("vulkan: no host-visible memory for a buffer".into());
        };
        let mut flags =
            vk::MemoryAllocateFlagsInfo::default().flags(vk::MemoryAllocateFlags::DEVICE_ADDRESS);
        let allocate = vk::MemoryAllocateInfo::default()
            .allocation_size(needs.size)
            .memory_type_index(kind)
            .push_next(&mut flags);
        // SAFETY: a live device; the allocate info lives through the call.
        let memory = match unsafe { d.allocate_memory(&allocate, None) } {
            Ok(memory) => memory,
            Err(e) => {
                destroy();
                return Err(vk_error("allocating memory")(e));
            }
        };
        // SAFETY: the buffer and memory just made, the memory big enough
        // for the buffer and of a host-visible type, so it maps.
        let mapped = unsafe {
            d.bind_buffer_memory(buffer, memory, 0)
                .and_then(|()| d.map_memory(memory, 0, needs.size, vk::MemoryMapFlags::empty()))
        };
        let Some(mapped) = mapped.ok().and_then(|p| NonNull::new(p.cast::<u8>())) else {
            destroy();
            // SAFETY: unused yet.
            unsafe { d.free_memory(memory, None) };
            return Err("vulkan: mapping memory failed".into());
        };
        // SAFETY: a buffer made with SHADER_DEVICE_ADDRESS, bound.
        let address = unsafe {
            d.get_buffer_device_address(&vk::BufferDeviceAddressInfo::default().buffer(buffer))
        };
        Ok(HostBuffer {
            device: device.clone(),
            buffer,
            memory,
            mapped,
            capacity,
            address,
        })
    }

    pub(super) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Its first `len` bytes (up to its capacity), as the GPU left them:
    /// once the device is idle, and so done writing them. Nothing can copy
    /// into it while they are borrowed ([`Frame::draw`] takes it mutably).
    pub(super) fn read(&self, len: usize) -> Result<&[u8], String> {
        self.device.wait_idle()?;
        // SAFETY: mapped memory of `capacity` bytes, which nothing writes
        // while it is borrowed: the device is idle, and the CPU writes
        // only through &mut self.
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
        // SAFETY: mapped memory of `capacity` bytes, borrowed mutably from
        // its only owner, while the GPU uses it no more (see above).
        unsafe { std::slice::from_raw_parts_mut(self.mapped.as_ptr(), len) }
    }
}

impl Drop for HostBuffer {
    fn drop(&mut self) {
        // SAFETY: commands that read or write it may still run: wait for
        // them. Freeing the memory unmaps it.
        unsafe {
            let _ = self.device.raw.device_wait_idle();
            self.device.raw.destroy_buffer(self.buffer, None);
            self.device.raw.free_memory(self.memory, None);
        }
    }
}

/// Data a frame puts in a buffer: written into its mapped memory.
pub(super) enum Data<'a> {
    Bytes(&'a [u8]),
    Words(&'a [u32]),
    /// Each item's floats, in order.
    Floats4(&'a [[f32; 4]]),
    Words2(&'a [[u32; 2]]),
}

impl Data<'_> {
    fn len(&self) -> usize {
        match self {
            Data::Bytes(b) => b.len(),
            Data::Words(w) => w.len() * 4,
            Data::Floats4(f) => f.len() * 16,
            Data::Words2(w) => w.len() * 8,
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
            Data::Floats4(f) => {
                for (o, v) in out.chunks_exact_mut(4).zip(f.iter().flatten()) {
                    o.copy_from_slice(&v.to_ne_bytes());
                }
            }
            Data::Words2(w) => {
                for (o, v) in out.chunks_exact_mut(4).zip(w.iter().flatten()) {
                    o.copy_from_slice(&v.to_ne_bytes());
                }
            }
        }
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

// MARK: Images and synchronization

/// What a frame is drawn into: an image of `extent`, left in `layout`.
/// Made only by this module's owners of images, so its handles are live.
#[derive(Clone, Copy)]
pub(super) struct Target {
    image: vk::Image,
    view: vk::ImageView,
    pub(super) extent: vk::Extent2D,
    layout: vk::ImageLayout,
}

const COLOR_RANGE: vk::ImageSubresourceRange = vk::ImageSubresourceRange {
    aspect_mask: vk::ImageAspectFlags::COLOR,
    base_mip_level: 0,
    level_count: 1,
    base_array_layer: 0,
    layer_count: 1,
};

fn image_view(
    device: &Device,
    image: vk::Image,
    format: vk::Format,
) -> Result<vk::ImageView, String> {
    let info = vk::ImageViewCreateInfo::default()
        .image(image)
        .view_type(vk::ImageViewType::TYPE_2D)
        .format(format)
        .subresource_range(COLOR_RANGE);
    // SAFETY: a live device and image; the create info lives through it.
    unsafe { device.raw.create_image_view(&info, None) }.map_err(vk_error("creating an image view"))
}

/// An image on the device to draw into and copy from: frames drawn with no
/// window.
pub(super) struct Image {
    device: Arc<Device>,
    image: vk::Image,
    memory: vk::DeviceMemory,
    view: vk::ImageView,
    pub(super) extent: vk::Extent2D,
}

impl Image {
    pub(super) fn new(
        device: &Arc<Device>,
        extent: vk::Extent2D,
        format: vk::Format,
    ) -> Result<Image, String> {
        let d = &device.raw;
        let info = vk::ImageCreateInfo::default()
            .image_type(vk::ImageType::TYPE_2D)
            .format(format)
            .extent(vk::Extent3D {
                width: extent.width,
                height: extent.height,
                depth: 1,
            })
            .mip_levels(1)
            .array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1)
            .tiling(vk::ImageTiling::OPTIMAL)
            .usage(vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC)
            .sharing_mode(vk::SharingMode::EXCLUSIVE)
            .initial_layout(vk::ImageLayout::UNDEFINED);
        // SAFETY: a live device; the create info lives through the call.
        // Until the image is whole, failures destroy what was made, and
        // then Drop does.
        let image =
            unsafe { d.create_image(&info, None) }.map_err(vk_error("creating an image"))?;
        // SAFETY: the image just made.
        let needs = unsafe { d.get_image_memory_requirements(image) };
        let kind = device
            .memory_type(
                needs.memory_type_bits,
                vk::MemoryPropertyFlags::DEVICE_LOCAL,
            )
            .or_else(|| {
                device.memory_type(needs.memory_type_bits, vk::MemoryPropertyFlags::empty())
            });
        let allocated = kind
            .ok_or_else(|| "vulkan: no memory for an image".to_string())
            .and_then(|kind| {
                let allocate = vk::MemoryAllocateInfo::default()
                    .allocation_size(needs.size)
                    .memory_type_index(kind);
                // SAFETY: a live device; the info lives through the call.
                unsafe { d.allocate_memory(&allocate, None) }.map_err(vk_error("allocating memory"))
            });
        let memory = match allocated {
            Ok(memory) => memory,
            Err(error) => {
                // SAFETY: unused yet.
                unsafe { d.destroy_image(image, None) };
                return Err(error);
            }
        };
        let mut made = Image {
            device: device.clone(),
            image,
            memory,
            view: vk::ImageView::null(),
            extent,
        };
        // SAFETY: the image and memory just made, big enough for it.
        unsafe { d.bind_image_memory(image, memory, 0) }.map_err(vk_error("binding memory"))?;
        made.view = image_view(device, image, format)?;
        Ok(made)
    }

    /// Drawn into, it is left ready to be copied from.
    pub(super) fn target(&self) -> Target {
        Target {
            image: self.image,
            view: self.view,
            extent: self.extent,
            layout: vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        // SAFETY: commands that draw into it may still run: wait for them.
        // A null view (never made) destroys as nothing.
        unsafe {
            let d = &self.device.raw;
            let _ = d.device_wait_idle();
            d.destroy_image_view(self.view, None);
            d.destroy_image(self.image, None);
            d.free_memory(self.memory, None);
        }
    }
}

/// A semaphore: one submission signals it, another waits for it.
pub(super) struct Semaphore {
    device: Arc<Device>,
    raw: vk::Semaphore,
}

impl Semaphore {
    pub(super) fn new(device: &Arc<Device>) -> Result<Semaphore, String> {
        // SAFETY: a live device.
        let raw = unsafe {
            device
                .raw
                .create_semaphore(&vk::SemaphoreCreateInfo::default(), None)
        }
        .map_err(vk_error("creating a semaphore"))?;
        Ok(Semaphore {
            device: device.clone(),
            raw,
        })
    }
}

impl Drop for Semaphore {
    fn drop(&mut self) {
        // SAFETY: submissions and presentations waiting on it may still be
        // pending: wait for them.
        unsafe {
            let _ = self.device.raw.device_wait_idle();
            self.device.raw.destroy_semaphore(self.raw, None);
        }
    }
}

// MARK: Frames

/// What the shaders' push constants hold: `Params` in kernel/gui.slang.
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
}

impl Params {
    /// Six addresses, six floats, and two u32s (one of them padding).
    const BYTES: usize = 6 * 8 + 6 * 4 + 2 * 4;

    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::BYTES);
        for a in [
            self.rects,
            self.glyphs,
            self.curves,
            self.bands,
            self.pictures,
            self.pixels,
        ] {
            out.extend_from_slice(&a.to_ne_bytes());
        }
        for f in self.cell.iter().chain(&self.viewport).chain(&self.origin) {
            out.extend_from_slice(&f.to_ne_bytes());
        }
        out.extend_from_slice(&self.linear.to_ne_bytes());
        out.extend_from_slice(&0u32.to_ne_bytes());
        out
    }
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

/// A frame in flight: its commands, the fence that says the GPU is done
/// with them, and the buffers they read.
pub(super) struct Frame {
    buffers: Buffers,
    /// Signaled when the swapchain image it acquired may be drawn; and
    /// whether the frame's next drawing must wait for that.
    acquired: Option<Semaphore>,
    pending: bool,
    device: Arc<Device>,
    pool: vk::CommandPool,
    commands: vk::CommandBuffer,
    done: vk::Fence,
}

impl Frame {
    pub(super) fn new(device: &Arc<Device>) -> Result<Frame, String> {
        let d = &device.raw;
        let info = vk::CommandPoolCreateInfo::default()
            .queue_family_index(device.family)
            .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER);
        // SAFETY: a live device; the create info lives through the call.
        let pool = unsafe { d.create_command_pool(&info, None) }
            .map_err(vk_error("creating a command pool"))?;
        let mut frame = Frame {
            buffers: Buffers::default(),
            acquired: None,
            pending: false,
            device: device.clone(),
            pool,
            commands: vk::CommandBuffer::null(),
            done: vk::Fence::null(),
        };
        // SAFETY: the pool just made; a fence signaled, as the frame has
        // nothing in flight yet. Drop destroys what was made.
        unsafe {
            frame.commands = d
                .allocate_command_buffers(
                    &vk::CommandBufferAllocateInfo::default()
                        .command_pool(pool)
                        .level(vk::CommandBufferLevel::PRIMARY)
                        .command_buffer_count(1),
                )
                .map_err(vk_error("allocating commands"))?[0];
            frame.done = d
                .create_fence(
                    &vk::FenceCreateInfo::default().flags(vk::FenceCreateFlags::SIGNALED),
                    None,
                )
                .map_err(vk_error("creating a fence"))?;
        }
        Ok(frame)
    }

    /// Waits until the GPU is done with the frame's last commands.
    pub(super) fn wait(&self) -> Result<(), String> {
        // SAFETY: the frame's own fence.
        unsafe {
            self.device
                .raw
                .wait_for_fences(&[self.done], true, u64::MAX)
        }
        .map_err(vk_error("waiting for a frame"))
    }

    /// The next image of `swapchain` for the frame to draw into, waiting at
    /// most `timeout` nanoseconds for one. Its next drawing waits until the
    /// image may be drawn.
    pub(super) fn acquire(
        &mut self,
        swapchain: &Swapchain,
        timeout: u64,
    ) -> Result<Acquired, String> {
        // Its last drawing, which waited for the semaphore's last signal, is
        // done: nothing is pending on the semaphore.
        self.wait()?;
        if self.acquired.is_none() {
            self.acquired = Some(Semaphore::new(&self.device)?);
        }
        let acquired = swapchain.acquire(self.acquired.as_ref().expect("made above"), timeout)?;
        self.pending = matches!(acquired, Acquired::Image(..));
        Ok(acquired)
    }

    /// Draws `list` into `target` with `pipelines`, once the frame's last
    /// commands are done: fills its buffers, records, and submits, waiting
    /// for the image it acquired, if it did, and signaling `signal`. The
    /// image is copied into `copy`, if there is one, after it is drawn.
    pub(super) fn draw(
        &mut self,
        pipelines: &Pipelines,
        list: &DrawList,
        target: Target,
        copy: Option<&mut HostBuffer>,
        signal: Option<&Semaphore>,
    ) -> Result<(), String> {
        if !Arc::ptr_eq(&pipelines.device, &self.device) {
            return Err("vulkan: pipelines of another device".into());
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
        let [r, g, bl] = [16, 8, 0].map(|shift| {
            let v = f32::from(((list.background >> shift) & 0xFF) as u8) / 255.0;
            if linear { linearize(v) } else { v }
        });
        let extent = target.extent;
        let viewport = [extent.width as f32, extent.height as f32];
        let draws = [
            (pipelines.rect, rects, list.rects.len() / RECT_BYTES),
            (
                pipelines.image,
                pictures,
                list.pictures.len() / PICTURE_BYTES,
            ),
            (pipelines.glyph, glyphs, list.glyphs.len() / GLYPH_BYTES),
            (
                pipelines.rect,
                decorations,
                list.decorations.len() / RECT_BYTES,
            ),
        ];
        let d = &device.raw;
        let c = self.commands;
        let attachments = [vk::RenderingAttachmentInfo::default()
            .image_view(target.view)
            .image_layout(vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL)
            .load_op(vk::AttachmentLoadOp::CLEAR)
            .store_op(vk::AttachmentStoreOp::STORE)
            .clear_value(vk::ClearValue {
                color: vk::ClearColorValue {
                    float32: [r, g, bl, 1.0],
                },
            })];
        let area = vk::Rect2D {
            offset: vk::Offset2D::default(),
            extent,
        };
        // SAFETY: the frame's own command buffer, not in use (its fence
        // waited for), recorded with handles of live objects of this
        // device: the pipelines, the target's image and view (made only by
        // their owners here, which wait for the device before destroying
        // them), and buffers the frame owns, whose addresses the push
        // constants carry. Every info lives through its call.
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
                    width: viewport[0],
                    height: viewport[1],
                    min_depth: 0.0,
                    max_depth: 1.0,
                }],
            );
            d.cmd_set_scissor(c, 0, &[area]);
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
                };
                d.cmd_push_constants(
                    c,
                    pipelines.layout,
                    vk::ShaderStageFlags::VERTEX | vk::ShaderStageFlags::FRAGMENT,
                    0,
                    &params.bytes(),
                );
                d.cmd_draw(c, 4, count as u32, 0, 0);
            }
            d.cmd_end_rendering(c);
            let mut layout = vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL;
            if let Some(copy) = copy {
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
                // Only what fits: a buffer smaller than the image takes
                // none of it.
                let bytes = extent.width as usize * extent.height as usize * 4;
                if copy.capacity >= bytes {
                    d.cmd_copy_image_to_buffer(
                        c,
                        target.image,
                        layout,
                        copy.buffer,
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
                .map_err(vk_error("recording commands"))?;
        }

        let wait = if std::mem::take(&mut self.pending) {
            self.acquired.as_ref()
        } else {
            None
        };
        let waits: Vec<_> = wait
            .map(|s| {
                vk::SemaphoreSubmitInfo::default()
                    .semaphore(s.raw)
                    .stage_mask(vk::PipelineStageFlags2::COLOR_ATTACHMENT_OUTPUT)
            })
            .into_iter()
            .collect();
        let signals: Vec<_> = signal
            .map(|s| {
                vk::SemaphoreSubmitInfo::default()
                    .semaphore(s.raw)
                    .stage_mask(vk::PipelineStageFlags2::ALL_COMMANDS)
            })
            .into_iter()
            .collect();
        let buffers = [vk::CommandBufferSubmitInfo::default().command_buffer(c)];
        // SAFETY: the frame's fence (signaled, so not in use) and its
        // recorded commands, submitted to the device's queue (the windows'
        // thread is the only one that submits); the semaphores are live
        // ones of this device. Every info lives through the call.
        unsafe {
            d.reset_fences(&[self.done])
                .map_err(vk_error("resetting a fence"))?;
            d.queue_submit2(
                device.queue,
                &[vk::SubmitInfo2::default()
                    .wait_semaphore_infos(&waits)
                    .command_buffer_infos(&buffers)
                    .signal_semaphore_infos(&signals)],
                self.done,
            )
            .map_err(vk_error("submitting"))
        }
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        // SAFETY: its commands may still run: wait for them. The pool
        // frees its command buffer; null handles destroy as nothing.
        unsafe {
            let _ = self.device.raw.device_wait_idle();
            self.device.raw.destroy_fence(self.done, None);
            self.device.raw.destroy_command_pool(self.pool, None);
        }
    }
}

/// A layout transition of `image`, between the stages that draw into and
/// copy from it.
///
/// # Safety
///
/// `commands` is recording, and `image` is a live image of `d`.
unsafe fn barrier(
    d: &ash::Device,
    commands: vk::CommandBuffer,
    image: vk::Image,
    (old, new): (vk::ImageLayout, vk::ImageLayout),
    (src, dst): (vk::AccessFlags2, vk::AccessFlags2),
) {
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
    // SAFETY: as the caller promises; the info lives through the call.
    unsafe {
        d.cmd_pipeline_barrier2(
            commands,
            &vk::DependencyInfo::default().image_memory_barriers(&barriers),
        )
    };
}

// MARK: Windows

/// A window's surface, on an instance. It holds the window, whose display
/// and surface it draws to.
pub(super) struct Surface {
    instance: Arc<Instance>,
    fns: ash::khr::surface::Instance,
    raw: vk::SurfaceKHR,
    // After `raw`, which Drop destroys first.
    _window: Arc<Window>,
}

impl Surface {
    /// A surface for `window`.
    pub(super) fn new(instance: &Arc<Instance>, window: &Arc<Window>) -> Result<Surface, String> {
        let display = window.display_handle().map_err(|e| e.to_string())?.as_raw();
        let handle = window.window_handle().map_err(|e| e.to_string())?.as_raw();
        let (entry, raw_instance) = (&instance.entry, &instance.raw);
        let made = match (display, handle) {
            // SAFETY: the handles are the window's and its display's, which
            // the surface holds; the create info lives through the call.
            (RawDisplayHandle::Wayland(d), RawWindowHandle::Wayland(w)) => unsafe {
                ash::khr::wayland_surface::Instance::new(entry, raw_instance)
                    .create_wayland_surface(
                        &vk::WaylandSurfaceCreateInfoKHR::default()
                            .display(d.display.as_ptr().cast())
                            .surface(w.surface.as_ptr().cast()),
                        None,
                    )
            },
            (RawDisplayHandle::Xlib(d), RawWindowHandle::Xlib(w)) => {
                let dpy = d.display.ok_or("X11: no display")?;
                // SAFETY: as for Wayland's.
                unsafe {
                    ash::khr::xlib_surface::Instance::new(entry, raw_instance).create_xlib_surface(
                        &vk::XlibSurfaceCreateInfoKHR::default()
                            .dpy(dpy.as_ptr().cast())
                            .window(w.window),
                        None,
                    )
                }
            }
            _ => return Err("only Wayland and X11 (Xlib) windows are supported".into()),
        };
        Ok(Surface {
            instance: instance.clone(),
            fns: ash::khr::surface::Instance::new(entry, raw_instance),
            raw: made.map_err(vk_error("creating a surface"))?,
            _window: window.clone(),
        })
    }

    fn checked(&self, physical: &Physical) -> Result<(), String> {
        if Arc::ptr_eq(&self.instance, &physical.instance) {
            Ok(())
        } else {
            Err("vulkan: a device of another instance".into())
        }
    }

    /// Whether `physical`'s queue family `family` presents to it.
    pub(super) fn supports(&self, physical: &Physical, family: u32) -> bool {
        self.checked(physical).is_ok()
            // SAFETY: the surface's own instance's device, and the surface.
            && unsafe {
                self.fns
                    .get_physical_device_surface_support(physical.raw, family, self.raw)
            }
            .unwrap_or(false)
    }

    /// Its format on `physical`: sRGB, so that frames blend in linear
    /// light, else UNORM, which takes sRGB colors as they are (see
    /// kernel/gui.slang).
    pub(super) fn format(&self, physical: &Physical) -> Result<vk::SurfaceFormatKHR, String> {
        self.checked(physical)?;
        // SAFETY: as for supports.
        let formats = unsafe {
            self.fns
                .get_physical_device_surface_formats(physical.raw, self.raw)
        }
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

    fn capabilities(&self, physical: &Physical) -> Result<vk::SurfaceCapabilitiesKHR, String> {
        self.checked(physical)?;
        // SAFETY: as for supports.
        unsafe {
            self.fns
                .get_physical_device_surface_capabilities(physical.raw, self.raw)
        }
        .map_err(vk_error("reading the surface's capabilities"))
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: swapchains made for it hold it, so are gone.
        unsafe { self.fns.destroy_surface(self.raw, None) };
    }
}

/// A surface's swapchain: its images, a view of each, and a semaphore for
/// each, signaled when it is drawn, for presenting it.
pub(super) struct Swapchain {
    rendered: Vec<Semaphore>,
    device: Arc<Device>,
    surface: Arc<Surface>,
    fns: ash::khr::swapchain::Device,
    raw: vk::SwapchainKHR,
    images: Vec<vk::Image>,
    views: Vec<vk::ImageView>,
    pub(super) extent: vk::Extent2D,
}

/// What became of asking for an image to draw into.
pub(super) enum Acquired {
    /// The image's index, and whether the swapchain should be made again.
    Image(u32, bool),
    /// None now: try again later (the window is hidden).
    NotYet,
    /// The swapchain no longer fits the surface: make it again.
    OutOfDate,
}

impl Swapchain {
    /// A swapchain for `surface` on `device`, its images of the size the
    /// surface says (else `size`), in `format`; replacing `old`, if there is
    /// one. None while the surface has no area.
    pub(super) fn new(
        device: &Arc<Device>,
        surface: &Arc<Surface>,
        format: vk::SurfaceFormatKHR,
        size: [u32; 2],
        copied: bool,
        old: Option<Swapchain>,
    ) -> Result<Option<Swapchain>, String> {
        let caps = surface.capabilities(device.physical())?;
        let extent = if caps.current_extent.width != u32::MAX {
            caps.current_extent
        } else {
            vk::Extent2D {
                width: size[0].clamp(caps.min_image_extent.width, caps.max_image_extent.width),
                height: size[1].clamp(caps.min_image_extent.height, caps.max_image_extent.height),
            }
        };
        if extent.width == 0 || extent.height == 0 {
            return Ok(None);
        }
        device.wait_idle()?;
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
        let usage = if copied {
            vk::ImageUsageFlags::COLOR_ATTACHMENT | vk::ImageUsageFlags::TRANSFER_SRC
        } else {
            vk::ImageUsageFlags::COLOR_ATTACHMENT
        };
        let fns = ash::khr::swapchain::Device::new(&device.physical.instance.raw, &device.raw);
        // FIFO, which every device has: frames are drawn only when the
        // compositor asks for one (gui/window.rs draws at its frame
        // callbacks), so none waits, and none is drawn to be thrown away,
        // as mailbox would.
        let info = vk::SwapchainCreateInfoKHR::default()
            .surface(surface.raw)
            .min_image_count(count)
            .image_format(format.format)
            .image_color_space(format.color_space)
            .image_extent(extent)
            .image_array_layers(1)
            .image_usage(usage)
            .image_sharing_mode(vk::SharingMode::EXCLUSIVE)
            .pre_transform(caps.current_transform)
            .composite_alpha(alpha)
            .present_mode(vk::PresentModeKHR::FIFO)
            .clipped(true)
            .old_swapchain(old.as_ref().map_or(vk::SwapchainKHR::null(), |s| s.raw));
        // SAFETY: the device's own surface (its instance checked by
        // capabilities above), and the old swapchain, if any, is live; the
        // create info lives through the call.
        let created = unsafe { fns.create_swapchain(&info, None) };
        drop(old);
        let mut made = Swapchain {
            rendered: Vec::new(),
            device: device.clone(),
            surface: surface.clone(),
            fns,
            raw: created.map_err(vk_error("creating the swapchain"))?,
            images: Vec::new(),
            views: Vec::new(),
            extent,
        };
        // SAFETY: the swapchain just made.
        made.images = unsafe { made.fns.get_swapchain_images(made.raw) }
            .map_err(vk_error("listing swapchain images"))?;
        for i in 0..made.images.len() {
            let view = image_view(device, made.images[i], format.format)?;
            made.views.push(view);
            made.rendered.push(Semaphore::new(device)?);
        }
        Ok(Some(made))
    }

    /// The next image to draw into, signaling `acquired` once it may be
    /// drawn; waiting at most `timeout` nanoseconds for one. Only a
    /// [`Frame`] acquires, with its own semaphore, once nothing is pending
    /// on it.
    fn acquire(&self, acquired: &Semaphore, timeout: u64) -> Result<Acquired, String> {
        // SAFETY: the swapchain, and a live semaphore with nothing pending
        // on it (see Frame::acquire).
        match unsafe {
            self.fns
                .acquire_next_image(self.raw, timeout, acquired.raw, vk::Fence::null())
        } {
            Ok((index, suboptimal)) => Ok(Acquired::Image(index, suboptimal)),
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => Ok(Acquired::OutOfDate),
            Err(vk::Result::TIMEOUT | vk::Result::NOT_READY) => Ok(Acquired::NotYet),
            Err(e) => Err(vk_error("acquiring an image")(e)),
        }
    }

    /// Image `index`, to draw into, left ready to present.
    pub(super) fn target(&self, index: u32) -> Target {
        let i = index as usize;
        Target {
            image: self.images[i],
            view: self.views[i],
            extent: self.extent,
            layout: vk::ImageLayout::PRESENT_SRC_KHR,
        }
    }

    /// The semaphore drawing image `index` signals, which presenting it
    /// waits for.
    pub(super) fn rendered(&self, index: u32) -> &Semaphore {
        &self.rendered[index as usize]
    }

    /// Presents image `index` once it is drawn, saying which rectangles
    /// changed (none: all of it). Returns whether the swapchain should be
    /// made again.
    pub(super) fn present(&self, index: u32, changed: &[vk::RectLayerKHR]) -> Result<bool, String> {
        let swapchains = [self.raw];
        let indices = [index];
        let waits = [self.rendered(index).raw];
        let regions = [vk::PresentRegionKHR::default().rectangles(changed)];
        let mut present_regions = vk::PresentRegionsKHR::default().regions(&regions);
        let mut info = vk::PresentInfoKHR::default()
            .wait_semaphores(&waits)
            .swapchains(&swapchains)
            .image_indices(&indices);
        if !changed.is_empty() && self.device.incremental_present {
            info = info.push_next(&mut present_regions);
        }
        // SAFETY: an image of the swapchain acquired and drawn (the
        // semaphore its drawing signals), on the device's queue; regions
        // only where the device has the extension. The info lives through
        // the call.
        match unsafe { self.fns.queue_present(self.device.queue, &info) } {
            Ok(suboptimal) => Ok(suboptimal),
            Err(vk::Result::ERROR_OUT_OF_DATE_KHR) => Ok(true),
            Err(e) => Err(vk_error("presenting")(e)),
        }
    }
}

impl Drop for Swapchain {
    fn drop(&mut self) {
        // SAFETY: drawing into and presenting its images may still be
        // pending: wait for the device. Then its views, then it.
        unsafe {
            let _ = self.device.raw.device_wait_idle();
            for &view in &self.views {
                self.device.raw.destroy_image_view(view, None);
            }
            self.fns.destroy_swapchain(self.raw, None);
        }
        // Then its semaphores and what it holds: its device, and its
        // surface, which must outlive it.
    }
}
