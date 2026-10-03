// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Compile-time platform detection.

use anyhow::{Result, bail};

/// Returns the platform key for the current host (e.g. "linux-x86_64").
///
/// This is determined at compile time via `cfg!()` and matches the platform
/// key format used in DotSlash manifests.
pub fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "macos-x86_64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
}

/// Look up the platform entry for the current host from the manifest's
/// platform map, returning an error if this platform is not supported.
pub fn resolve_platform<'a, V>(
    platforms: &'a std::collections::HashMap<String, V>,
) -> Result<&'a V> {
    let key = current_platform_key();
    match platforms.get(key) {
        Some(entry) => Ok(entry),
        None => {
            let available: Vec<&String> = platforms.keys().collect();
            bail!(
                "no entry for platform '{}'; available: {:?}",
                key,
                available
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_current_platform_key_not_empty() {
        let key = current_platform_key();
        assert!(!key.is_empty());
        assert!(key.contains('-'));
    }

    #[test]
    fn test_resolve_platform_found() {
        let mut platforms = HashMap::new();
        platforms.insert(current_platform_key().to_string(), 42);
        let val = resolve_platform(&platforms).unwrap();
        assert_eq!(*val, 42);
    }

    #[test]
    fn test_resolve_platform_missing() {
        let platforms: HashMap<String, i32> = HashMap::new();
        let err = resolve_platform(&platforms).unwrap_err();
        assert!(err.to_string().contains("no entry for platform"));
    }
}
