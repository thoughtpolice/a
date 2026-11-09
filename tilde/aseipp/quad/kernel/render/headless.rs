// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing with no window: into an image, read back, for tests and
//! snapshots.

use super::*;

// MARK: Without a window

/// An image to draw into, on the device.
pub(super) struct Image {
    pub(super) image: vk::Image,
    pub(super) memory: vk::DeviceMemory,
    pub(super) view: vk::ImageView,
    pub(super) extent: vk::Extent2D,
}

/// Draws frames into an image, with no window: for tests, and snapshots.
pub struct Headless {
    pub(super) commands: Commands,
    pub(super) buffers: Buffers,
    pub(super) image: Option<Image>,
    pub(super) readback: Option<HostBuffer>,
    // Last, so that it is dropped last.
    pub(super) gpu: Gpu,
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

    pub(super) unsafe fn create_image(&self, extent: vk::Extent2D) -> Result<Image, String> {
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

    pub(super) unsafe fn destroy_image(&self, i: Image) {
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
