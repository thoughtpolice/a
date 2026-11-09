// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing with Metal 4, on macOS: the device and its pipelines ([`Gpu`]),
//! made ahead of the first window as Vulkan's are on Linux ([`prepare`]);
//! a window's frames, drawn into its layer's drawables and shown as the
//! display refreshes ([`Renderer`]); and frames drawn into images, with no
//! window ([`Headless`]). Metal is called in metal.rs alone.
//!
//! A window draws in BGRA8 sRGB, so that frames blend in linear light (see
//! kernel/gui.slang), and its layer says its colors are sRGB's, which macOS
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
    device: Arc<Device>,
    pipelines: Pipelines,
}

impl Gpu {
    /// The device (see [`Device::new`]), drawing in `format`.
    fn new(format: MTLPixelFormat) -> Result<Gpu, String> {
        let device = Device::new()?;
        let pipelines = Pipelines::new(&device, format)?;
        Ok(Gpu { device, pipelines })
    }
}

// MARK: Windows

/// Draws frames in a window.
pub struct Renderer {
    frames: Vec<Frame>,
    layer: Layer,
    frame: usize,
    /// With `QUAD_GUI_SNAPSHOT=FILE`, each frame presented is also written
    /// to FILE, as a PPM image: what the window shows.
    snapshot: Option<std::path::PathBuf>,
    snapshot_buffer: Option<HostBuffer>,
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
            Some(gpu) => gpu,
            None => Gpu::new(WINDOW_FORMAT)?,
        };
        let gpu = Rc::new(gpu);
        *shared = Some(gpu.clone());
        Renderer::on(gpu, window)
    }

    fn on(gpu: Rc<Gpu>, window: &Arc<Window>) -> Result<Renderer, String> {
        let snapshot: Option<std::path::PathBuf> =
            std::env::var_os("QUAD_GUI_SNAPSHOT").map(Into::into);
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
            snapshot_buffer: None,
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
        let copy = self.snapshot.as_ref().and(self.snapshot_buffer.as_mut());
        frame.draw(
            &self.gpu.pipelines,
            list,
            drawable.target(),
            copy,
            Some(&drawable),
        )?;
        if self.snapshot.is_some() {
            self.write_snapshot(drawable.extent)?;
        }
        self.frame = (self.frame + 1) % FRAMES_IN_FLIGHT;
        Ok(true)
    }

    /// Writes the frame just drawn to the snapshot file, and makes sure the
    /// next frame has a buffer of `extent`'s size to copy into.
    fn write_snapshot(&mut self, extent: [u32; 2]) -> Result<(), String> {
        let bytes = extent[0] as usize * extent[1] as usize * 4;
        if let Some(buffer) = self
            .snapshot_buffer
            .as_ref()
            .filter(|b| b.capacity() >= bytes)
        {
            let pixels = buffer.read(bytes)?;
            let path = self.snapshot.as_ref().expect("checked by the caller");
            return write_ppm(path, extent, pixels, true);
        }
        // The next frame is copied into it; this one, drawn with no buffer
        // to copy into, is not written.
        self.snapshot_buffer = None;
        self.snapshot_buffer = Some(HostBuffer::new(&self.gpu.device, bytes, true)?);
        Ok(())
    }
}

// MARK: Made ahead

/// The device being made ahead ([`prepare`]).
static PREPARED: Mutex<Option<JoinHandle<Result<Gpu, String>>>> = Mutex::new(None);

/// Starts making the device the first window will draw with, on another
/// thread, unless one is made or being made: Metal compiles the shaders as
/// it is made, which takes longer than the rest of opening a window.
pub fn prepare() {
    let mut prepared = PREPARED.lock().unwrap_or_else(|e| e.into_inner());
    if prepared.is_some() {
        return;
    }
    let made = std::thread::Builder::new()
        .name("quad-gpu".into())
        .spawn(|| Gpu::new(WINDOW_FORMAT));
    if let Ok(handle) = made {
        *prepared = Some(handle);
    }
}

/// Waits for the device being made ahead, if one is, before the process
/// exits (kernel.c calls this), as on Linux, where a driver still loading
/// must not race the exit.
#[unsafe(no_mangle)]
pub extern "C" fn quad_gui_settle() {
    let made = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(handle) = made {
        // The process is ending: the device goes with it.
        if let Ok(Ok(gpu)) = handle.join() {
            std::mem::forget(gpu);
        }
    }
}

/// The device made ahead, waited for, if it was made.
fn take_prepared() -> Option<Gpu> {
    let made = PREPARED.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    made.join().ok()?.ok()
}

// MARK: No window

/// Draws frames into an image, with no window: for tests, and snapshots.
pub struct Headless {
    frame: Frame,
    image: Option<Image>,
    readback: Option<HostBuffer>,
    gpu: Gpu,
}

impl Headless {
    pub fn new() -> Result<Headless, String> {
        let gpu = Gpu::new(HEADLESS_FORMAT)?;
        Ok(Headless {
            frame: Frame::new(&gpu.device)?,
            image: None,
            readback: None,
            gpu,
        })
    }

    /// The device drawing, by name.
    pub fn device_name(&self) -> String {
        self.gpu.device.name()
    }

    /// Draws a frame `width` by `height` pixels; returns its pixels, RGBA,
    /// top row first.
    pub fn draw(&mut self, list: &DrawList, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let extent = [width.max(1), height.max(1)];
        let bytes = extent[0] as usize * extent[1] as usize * 4;
        if self.image.as_ref().is_none_or(|i| i.extent != extent) {
            self.image = None;
            self.image = Some(Image::new(&self.gpu.device, extent, HEADLESS_FORMAT)?);
        }
        if self.readback.as_ref().is_none_or(|b| b.capacity() < bytes) {
            self.readback = None;
            self.readback = Some(HostBuffer::new(&self.gpu.device, bytes, true)?);
        }
        let target = self.image.as_ref().expect("made above").target();
        self.frame.draw(
            &self.gpu.pipelines,
            list,
            target,
            self.readback.as_mut(),
            None,
        )?;
        let readback = self.readback.as_ref().expect("made above");
        Ok(readback.read(bytes)?.to_vec())
    }
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
