// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing with no window: into an image, read back, for tests and
//! snapshots.

use super::*;

/// Draws frames into an image, with no window: for tests, and snapshots.
pub struct Headless {
    frame: Frame,
    image: Option<Image>,
    readback: Option<HostBuffer>,
    gpu: Gpu,
}

impl Headless {
    pub fn new() -> Result<Headless, String> {
        let instance = Instance::load(&[])?;
        let (physical, family) = pick_device(&instance, None)?;
        let gpu = Gpu::new(physical, family, HEADLESS_FORMAT, false)?;
        Ok(Headless {
            frame: Frame::new(&gpu.device)?,
            image: None,
            readback: None,
            gpu,
        })
    }

    /// The device drawing, by name.
    pub fn device_name(&self) -> String {
        self.gpu.device.physical().name()
    }

    /// Draws a frame `width` by `height` pixels; returns its pixels, RGBA,
    /// top row first.
    pub fn draw(&mut self, list: &DrawList, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let extent = vk::Extent2D {
            width: width.max(1),
            height: height.max(1),
        };
        let bytes = extent.width as usize * extent.height as usize * 4;
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
