// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The device drawing and its pipelines, with a window or without; which
//! device that is; and what the shaders are called.

use super::*;

/// A device and its pipelines: what drawing needs. What is made on the
/// device holds it, so it goes only once they all have.
pub struct Gpu {
    pub(super) device: Arc<Device>,
    pub(super) pipelines: Pipelines,
}

impl Gpu {
    /// Makes `physical` a device drawing on its queue family `family`, in
    /// `format`; with a swapchain if `swapchain`.
    pub(super) fn new(
        physical: Physical,
        family: u32,
        format: vk::Format,
        swapchain: bool,
    ) -> Result<Gpu, String> {
        let device = Device::new(physical, family, swapchain)?;
        let pipelines = Pipelines::new(&device, format)?;
        Ok(Gpu { device, pipelines })
    }

    /// A device to draw with no window: the one [`pick_device`] picks.
    pub(super) fn headless() -> Result<Gpu, String> {
        let instance = Instance::load(&[])?;
        let (physical, family) = pick_device(&instance, None)?;
        Gpu::new(physical, family, HEADLESS_FORMAT, false)
    }

    /// The device, by name.
    pub(super) fn device_name(&self) -> String {
        self.device.physical().name()
    }

    pub(super) fn format(&self) -> vk::Format {
        self.pipelines.format
    }

    /// Draws in `format` from now on: pipelines made again for it.
    pub(super) fn set_format(&mut self, format: vk::Format) -> Result<(), String> {
        self.pipelines = Pipelines::new(&self.device, format)?;
        Ok(())
    }
}

/// A device with Vulkan 1.3 and buffer device addresses (both core there)
/// that can draw (and present to `surface`, if there is one), and its
/// queue family: the one `QUAD_GUI_DEVICE` names, else a discrete GPU
/// first, then an integrated one, then any.
pub(super) fn pick_device(
    instance: &Arc<Instance>,
    surface: Option<&Surface>,
) -> Result<(Physical, u32), String> {
    let wanted = std::env::var("QUAD_GUI_DEVICE")
        .ok()
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase());
    let mut best: Option<(u32, Physical, u32)> = None;
    let mut seen = Vec::new();
    for device in instance.physical_devices()? {
        let props = device.properties();
        let name = device.name();
        let named = wanted
            .as_ref()
            .is_none_or(|w| name.to_lowercase().contains(w));
        seen.push(name);
        if props.api_version < vk::API_VERSION_1_3 || !named {
            continue;
        }
        let family = device
            .queue_families()
            .iter()
            .enumerate()
            .find_map(|(i, f)| {
                let i = i as u32;
                let presents = surface.is_none_or(|s| s.supports(&device, i));
                (f.queue_flags.contains(vk::QueueFlags::GRAPHICS) && presents).then_some(i)
            });
        let Some(family) = family else { continue };
        let rank = match props.device_type {
            vk::PhysicalDeviceType::DISCRETE_GPU => 3,
            vk::PhysicalDeviceType::INTEGRATED_GPU => 2,
            vk::PhysicalDeviceType::VIRTUAL_GPU => 1,
            _ => 0,
        };
        if best.as_ref().is_none_or(|(r, _, _)| rank > *r) {
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
