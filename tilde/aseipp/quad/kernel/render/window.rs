// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing in a window: its swapchain, frames presented FIFO with the rows
//! that changed, and the device made ahead of the first window.

use super::*;

// MARK: In a window

pub(super) struct Swapchain {
    pub(super) swapchain: vk::SwapchainKHR,
    pub(super) images: Vec<vk::Image>,
    pub(super) views: Vec<vk::ImageView>,
    /// Signaled when an image's commands are done, for presenting it: one
    /// per image, since presentation holds it until the image comes back.
    pub(super) rendered: Vec<vk::Semaphore>,
    pub(super) extent: vk::Extent2D,
}

/// One frame in flight: its commands, its data, and the semaphore its
/// swapchain image is acquired with.
pub(super) struct InFlight {
    pub(super) commands: Commands,
    pub(super) buffers: Buffers,
    pub(super) acquired: vk::Semaphore,
}

/// Draws frames in a window.
pub struct Renderer {
    pub(super) surface_fn: ash::khr::surface::Instance,
    pub(super) surface: vk::SurfaceKHR,
    pub(super) swapchain_fn: ash::khr::swapchain::Device,
    pub(super) surface_format: vk::SurfaceFormatKHR,
    pub(super) present_mode: vk::PresentModeKHR,
    pub(super) swapchain: Option<Swapchain>,
    /// The window's size, for surfaces that have none of their own
    /// (Wayland's).
    pub(super) size: PhysicalSize<u32>,
    pub(super) stale: bool,
    /// The swapchain's images are new: the next frame changes all of the
    /// window, whatever its damage says.
    pub(super) fresh: bool,
    pub(super) frames: Vec<InFlight>,
    pub(super) frame: usize,
    /// With `QUAD_GUI_SNAPSHOT=FILE`, each frame presented is also written
    /// to FILE, as a PPM image: what the window shows.
    pub(super) snapshot: Option<std::path::PathBuf>,
    pub(super) snapshot_buffer: Option<HostBuffer>,
    // Last, so that it is dropped last: everything above is its device's,
    // which other windows' renderers may share.
    pub(super) gpu: Rc<Gpu>,
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
    pub(super) fn on(
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

    pub(super) unsafe fn init(&mut self) -> Result<(), String> {
        // FIFO, which every device has: frames are drawn only when the
        // compositor asks for one (gui/window.rs draws at its frame callbacks),
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
    pub(super) unsafe fn ensure_swapchain(&mut self) -> Result<bool, String> {
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

    pub(super) unsafe fn fill_swapchain(&self, s: &mut Swapchain) -> Result<(), String> {
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

    pub(super) unsafe fn destroy_swapchain(&self, s: Swapchain) {
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

    pub(super) unsafe fn draw_frame(
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
    pub(super) unsafe fn write_snapshot(
        &mut self,
        f: usize,
        extent: vk::Extent2D,
    ) -> Result<(), String> {
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
pub(super) unsafe fn surface_format(
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
pub(super) static PREPARED: Mutex<Option<(&'static CStr, JoinHandle<Result<Gpu, String>>)>> =
    Mutex::new(None);

/// The format a device is made ahead to draw in: what NVIDIA's driver
/// offers windows first. Pipelines are made again for another (Mesa's
/// drivers offer B8G8R8A8 first), which takes a millisecond.
pub(super) const PREPARED_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

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
pub(super) unsafe fn take_prepared(
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

pub(super) unsafe fn create_surface(
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

/// `damage` (rectangles in pixels: x, y, width, height) within an image of
/// `extent`, as presenting takes it.
pub(super) fn damage_rects(damage: &[[u32; 4]], extent: vk::Extent2D) -> Vec<vk::RectLayerKHR> {
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
}
