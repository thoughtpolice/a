// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing in a window: its swapchain, frames presented FIFO with the rows
//! that changed, and the device made ahead of the first window.

use super::*;

/// Draws frames in a window.
pub struct Renderer {
    frames: Vec<Frame>,
    swapchain: Option<Swapchain>,
    surface: Arc<Surface>,
    surface_format: vk::SurfaceFormatKHR,
    /// The window's size, for surfaces that have none of their own
    /// (Wayland's).
    size: PhysicalSize<u32>,
    stale: bool,
    /// The swapchain's images are new: the next frame changes all of the
    /// window, whatever its damage says.
    fresh: bool,
    frame: usize,
    snapshot: Option<Snapshot>,
    gpu: Rc<Gpu>,
}

impl Renderer {
    /// A renderer drawing into `window`, on the device `shared` holds: the
    /// one every window of this process draws with, made for the first
    /// window that needs it.
    pub fn new(window: &Arc<Window>, shared: &mut Option<Rc<Gpu>>) -> Result<Renderer, String> {
        if let Some(gpu) = shared {
            let physical = gpu.device.physical();
            let surface = Surface::new(physical.instance(), window)?;
            if !surface.supports(physical, gpu.device.family()) {
                return Err("the device cannot draw to this window".into());
            }
            // The pipelines draw in the format the device was set up with.
            let format = surface.format(physical)?;
            if format.format != gpu.format() {
                return Err("this window takes another color format than the others".into());
            }
            return Renderer::on(gpu.clone(), surface, format, window);
        }
        let display = window.display_handle().map_err(|e| e.to_string())?.as_raw();
        let surface_extension = match display {
            RawDisplayHandle::Wayland(_) => ash::khr::wayland_surface::NAME,
            RawDisplayHandle::Xlib(_) => ash::khr::xlib_surface::NAME,
            RawDisplayHandle::Windows(_) => ash::khr::win32_surface::NAME,
            _ => return Err("only Wayland, X11 (Xlib) and Win32 windows are supported".into()),
        };
        let (gpu, surface, format) = match take_prepared_for(surface_extension, window) {
            Some(prepared) => prepared,
            None => {
                let instance = Instance::load(&[ash::khr::surface::NAME, surface_extension])?;
                // The device is chosen for the first window's surface.
                let surface = Surface::new(&instance, window)?;
                let (physical, family) = pick_device(&instance, Some(&surface))?;
                let format = surface.format(&physical)?;
                (
                    Gpu::new(physical, family, format.format, true)?,
                    surface,
                    format,
                )
            }
        };
        let gpu = Rc::new(gpu);
        *shared = Some(gpu.clone());
        Renderer::on(gpu, surface, format, window)
    }

    /// A renderer on `gpu` for `window`, through `surface`, which `gpu`
    /// can draw to in `surface_format`.
    fn on(
        gpu: Rc<Gpu>,
        surface: Surface,
        surface_format: vk::SurfaceFormatKHR,
        window: &Arc<Window>,
    ) -> Result<Renderer, String> {
        let frames = (0..FRAMES_IN_FLIGHT)
            .map(|_| Frame::new(&gpu.device))
            .collect::<Result<_, _>>()?;
        Ok(Renderer {
            frames,
            swapchain: None,
            surface: Arc::new(surface),
            surface_format,
            size: window.inner_size(),
            stale: true,
            fresh: true,
            frame: 0,
            snapshot: Snapshot::from_env(),
            gpu,
        })
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) {
        if size != self.size {
            self.size = size;
            self.stale = true;
        }
    }

    /// (Re)makes the swapchain for the surface's current size. Returns
    /// false while the window has no area to draw.
    fn ensure_swapchain(&mut self) -> Result<bool, String> {
        if !self.stale && self.swapchain.is_some() {
            return Ok(true);
        }
        let made = Swapchain::new(
            &self.gpu.device,
            &self.surface,
            self.surface_format,
            [self.size.width, self.size.height],
            self.snapshot.is_some(),
            self.swapchain.take(),
        )?;
        let Some(swapchain) = made else {
            return Ok(false);
        };
        self.swapchain = Some(swapchain);
        self.stale = false;
        self.fresh = true;
        Ok(true)
    }

    /// Draws and presents a frame; returns whether it did, or whether it
    /// must be tried again (when the window is visible, or has a size).
    /// `damage` is what changed since the last frame presented, as
    /// rectangles in pixels (x, y, width, height), for the compositor to
    /// redraw only those; None, everything.
    pub fn draw(&mut self, list: &DrawList, damage: Option<&[[u32; 4]]>) -> Result<bool, String> {
        if !self.ensure_swapchain()? {
            return Ok(false);
        }
        let swapchain = self.swapchain.as_ref().expect("made above");
        let frame = &mut self.frames[self.frame];
        // Not forever: a compositor keeps a hidden window's images (a
        // minimized window, a locked screen), and the window's thread must
        // go on handling its events meanwhile.
        let index = match frame.acquire(swapchain, ACQUIRE_TIMEOUT_NS)? {
            Acquired::Image(index, suboptimal) => {
                self.stale |= suboptimal;
                index
            }
            Acquired::OutOfDate => {
                self.stale = true;
                return Ok(false);
            }
            Acquired::NotYet => return Ok(false),
        };
        let target = swapchain.target(index);
        let copy = self.snapshot.as_mut().and_then(Snapshot::buffer);
        frame.draw(
            &self.gpu.pipelines,
            list,
            target,
            copy,
            Some(swapchain.rendered(index)),
        )?;
        // With no rectangles, the whole image changed.
        let changed = damage
            .filter(|_| !self.fresh && self.gpu.device.incremental_present)
            .map(|damage| damage_rects(damage, target.extent))
            .unwrap_or_default();
        self.fresh = false;
        self.stale |= swapchain.present(index, &changed)?;
        if let Some(snapshot) = &mut self.snapshot {
            let bgra = matches!(
                self.surface_format.format,
                vk::Format::B8G8R8A8_UNORM | vk::Format::B8G8R8A8_SRGB
            );
            let extent = [target.extent.width, target.extent.height];
            // The frame that was not copied is drawn again.
            if !snapshot.write(&self.gpu.device, extent, bgra)? {
                self.stale = true;
            }
        }
        self.frame = (self.frame + 1) % FRAMES_IN_FLIGHT;
        Ok(true)
    }
}

// MARK: Made ahead

/// The format a device is made ahead to draw in: what NVIDIA's driver
/// offers windows first. Pipelines are made again for another (Mesa's
/// drivers offer B8G8R8A8 first), which takes a millisecond.
const PREPARED_FORMAT: vk::Format = vk::Format::R8G8B8A8_SRGB;

/// Starts making the device the first window will draw with, on another
/// thread, unless one is made or being made: for the display the
/// environment names (Wayland's, else X11's), as winit chooses it; on
/// Windows, for its windows.
pub fn prepare() {
    let Some(surface_extension) = surface_extension() else {
        return;
    };
    make_ahead(surface_extension, move || {
        let instance = Instance::load(&[ash::khr::surface::NAME, surface_extension])?;
        let (physical, family) = pick_device(&instance, None)?;
        Gpu::new(physical, family, PREPARED_FORMAT, true)
    });
}

/// The surface extension windows here take, if there is a display.
#[cfg(target_os = "linux")]
fn surface_extension() -> Option<&'static CStr> {
    let nonempty = |v: &str| std::env::var_os(v).is_some_and(|s| !s.is_empty());
    let x11 = std::env::var_os("QUAD_GUI_X11").is_some_and(|v| v == "1");
    if nonempty("WAYLAND_DISPLAY") && !x11 {
        Some(ash::khr::wayland_surface::NAME)
    } else if nonempty("DISPLAY") {
        Some(ash::khr::xlib_surface::NAME)
    } else {
        None
    }
}

#[cfg(windows)]
fn surface_extension() -> Option<&'static CStr> {
    Some(ash::khr::win32_surface::NAME)
}

/// The device made ahead, waited for, if it suits `window`: made for its
/// kind of display, able to draw to it, and made to draw in its format (or
/// made so again); with the window's surface, and its format.
fn take_prepared_for(
    surface_extension: &CStr,
    window: &Arc<Window>,
) -> Option<(Gpu, Surface, vk::SurfaceFormatKHR)> {
    let (made_for, mut gpu) = take_prepared()?;
    if made_for != surface_extension {
        return None;
    }
    let physical = gpu.device.physical();
    let surface = Surface::new(physical.instance(), window).ok()?;
    if !surface.supports(physical, gpu.device.family()) {
        return None;
    }
    let format = surface.format(physical).ok()?;
    if format.format != gpu.format() {
        timing::mark("the window draws in another format");
        gpu.set_format(format.format).ok()?;
    }
    Some((gpu, surface, format))
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
