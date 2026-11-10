// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Drawing with no window: into an image, read back, for tests and
//! snapshots. The same on Vulkan and Metal: each gives a device for it
//! ([`Gpu::headless`]), an image, a buffer to read back, and a frame.

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
        let gpu = Gpu::headless()?;
        Ok(Headless {
            frame: Frame::new(&gpu.device)?,
            image: None,
            readback: None,
            gpu,
        })
    }

    /// The device drawing, by name.
    pub fn device_name(&self) -> String {
        self.gpu.device_name()
    }

    /// Draws a frame `width` by `height` pixels; returns its pixels, RGBA,
    /// top row first.
    pub fn draw(&mut self, list: &DrawList, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let extent = [width.max(1), height.max(1)];
        let bytes = extent[0] as usize * extent[1] as usize * 4;
        if self.image.as_ref().is_none_or(|i| i.extent != extent) {
            self.image = None;
            let format = self.gpu.pipelines.format;
            self.image = Some(Image::new(&self.gpu.device, extent, format)?);
        }
        buffer_for(&self.gpu.device, &mut self.readback, bytes, true)?;
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
