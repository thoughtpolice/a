// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing with Metal 4, on macOS: the device and its pipelines ([`Gpu`]),
//! made ahead of the first window as Vulkan's are on Linux ([`prepare`]);
//! and a window's frames, drawn into its layer's drawables and shown as the
//! display refreshes ([`Renderer`]). Frames with no window are headless.rs's,
//! as on Linux. Metal is called in metal.rs alone.
//!
//! A window draws in BGRA8 sRGB, so that frames blend in linear light (see
//! kernel/render/gui.slang), and its layer says its colors are sRGB's, which macOS
//! matches to the display's, as terminals' are. Metal presents whole
//! drawables, so the rows a frame changed are not told to the compositor.

use objc2_metal::MTLPixelFormat;

use super::metal::*;
use super::*;

/// The format windows draw in.
const WINDOW_FORMAT: MTLPixelFormat = MTLPixelFormat::BGRA8Unorm_sRGB;

/// The format frames are drawn in, without a window: sRGB too, and in the
/// order of the pixels read back.
const HEADLESS_FORMAT: MTLPixelFormat = MTLPixelFormat::RGBA8Unorm_sRGB;

/// A device and its pipelines: what drawing needs. What is made on the
/// device holds it, so it goes only once they all have.
pub struct Gpu {
    pub(super) device: Arc<Device>,
    pub(super) pipelines: Pipelines,
}

impl Gpu {
    /// The device (see [`Device::new`]), drawing in `format`.
    fn new(format: MTLPixelFormat) -> Result<Gpu, String> {
        let device = Device::new()?;
        let pipelines = Pipelines::new(&device, format)?;
        Ok(Gpu { device, pipelines })
    }

    /// A device to draw with no window.
    pub(super) fn headless() -> Result<Gpu, String> {
        Gpu::new(HEADLESS_FORMAT)
    }

    /// The device, by name.
    pub(super) fn device_name(&self) -> String {
        self.device.name()
    }
}

// MARK: Windows

/// Draws frames in a window.
pub struct Renderer {
    frames: Vec<Frame>,
    layer: Layer,
    frame: usize,
    snapshot: Option<Snapshot>,
    gpu: Rc<Gpu>,
}

impl Renderer {
    /// A renderer drawing into `window`, on the device `shared` holds: the
    /// one every window of this process draws with, made for the first
    /// window that needs it (or ahead of it).
    pub fn new(window: &Arc<Window>, shared: &mut Option<Rc<Gpu>>) -> Result<Renderer, String> {
        if let Some(gpu) = shared {
            return Renderer::on(gpu.clone(), window);
        }
        let gpu = match take_prepared() {
            Some(((), gpu)) => gpu,
            None => Gpu::new(WINDOW_FORMAT)?,
        };
        let gpu = Rc::new(gpu);
        *shared = Some(gpu.clone());
        Renderer::on(gpu, window)
    }

    fn on(gpu: Rc<Gpu>, window: &Arc<Window>) -> Result<Renderer, String> {
        let snapshot = Snapshot::from_env();
        let layer = Layer::new(
            &gpu.device,
            window,
            gpu.pipelines.format,
            snapshot.is_some(),
        )?;
        let frames = (0..FRAMES_IN_FLIGHT)
            .map(|_| Frame::new(&gpu.device))
            .collect::<Result<_, _>>()?;
        Ok(Renderer {
            frames,
            layer,
            frame: 0,
            snapshot,
            gpu,
        })
    }

    /// The window is now `size` pixels: its drawables are made so.
    pub fn resize(&mut self, size: PhysicalSize<u32>) {
        self.layer.resize([size.width, size.height]);
    }

    /// Draws and presents a frame; returns whether it did, or whether it
    /// must be tried again (when the layer has a drawable to give).
    /// `damage`, what changed, is Linux's alone to use.
    pub fn draw(&mut self, list: &DrawList, _damage: Option<&[[u32; 4]]>) -> Result<bool, String> {
        let frame = &mut self.frames[self.frame];
        // Its last commands done before a drawable is taken, so that none
        // is held longer than drawing it takes.
        frame.wait()?;
        let Some(drawable) = self.layer.next() else {
            return Ok(false);
        };
        let copy = self.snapshot.as_mut().and_then(Snapshot::buffer);
        frame.draw(
            &self.gpu.pipelines,
            list,
            drawable.target(),
            copy,
            Some(&drawable),
        )?;
        // Windows draw in BGRA.
        if let Some(snapshot) = &mut self.snapshot {
            snapshot.write(&self.gpu.device, drawable.extent, true)?;
        }
        self.frame = (self.frame + 1) % FRAMES_IN_FLIGHT;
        Ok(true)
    }
}

// MARK: Made ahead

/// Starts making the device the first window will draw with, on another
/// thread, unless one is made or being made: Metal compiles the shaders as
/// it is made, which takes longer than the rest of opening a window.
pub fn prepare() {
    make_ahead((), || Gpu::new(WINDOW_FORMAT));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shaders compile, and their pipelines are made, wherever a device
    /// has Metal 4 (and nothing is checked where none does).
    #[test]
    fn the_shaders_compile_into_pipelines() {
        match Device::new() {
            Ok(device) => {
                Pipelines::new(&device, WINDOW_FORMAT).unwrap();
                Pipelines::new(&device, HEADLESS_FORMAT).unwrap();
            }
            Err(error) => eprintln!("skipped: {error}"),
        }
    }
}
