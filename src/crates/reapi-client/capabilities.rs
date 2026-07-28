// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! What a server says it can do.
//!
//! An owned, flattened view of REAPI's `ServerCapabilities`. Enum numbers are
//! resolved to names here rather than at the point of display, because which
//! number means what is protocol knowledge, not presentation.
//!
//! Names cover the whole REAPI enum, not just the functions this client can
//! use: a server that offers SHA-1 or SHA-256/TREE should say so, even though
//! transfers through this client cannot use them.

use protos::build::bazel::remote::execution::v2 as reapi;

/// A protocol version triple.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiVersion {
    pub major: i32,
    pub minor: i32,
    pub patch: i32,
}

impl std::fmt::Display for ApiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// A server's advertised capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerCapabilities {
    /// Digest function names the server accepts, e.g. `["SHA-256", "BLAKE3"]`.
    pub digest_functions: Vec<String>,
    /// Whether clients may write to the action cache.
    pub action_cache_update_enabled: bool,
    /// Total size ceiling for a single batch request, in bytes.
    pub max_batch_total_size_bytes: i64,
    /// Compressor names usable on blob transfers.
    pub supported_compressors: Vec<String>,
    /// How the server treats absolute symlink targets.
    pub symlink_absolute_path_strategy: String,
    /// Whether the server can execute actions, as opposed to only caching.
    pub exec_enabled: bool,
    pub low_api_version: Option<ApiVersion>,
    pub high_api_version: Option<ApiVersion>,
}

/// Matches what a server that advertises nothing flattens to, so that
/// `Default` and an empty response describe the same thing. Note that the
/// symlink strategy's zero value is a real enum member, `UNKNOWN`, not an
/// empty string.
impl Default for ServerCapabilities {
    fn default() -> Self {
        Self {
            digest_functions: Vec::new(),
            action_cache_update_enabled: false,
            max_batch_total_size_bytes: 0,
            supported_compressors: Vec::new(),
            symlink_absolute_path_strategy: symlink_strategy_name(0).to_string(),
            exec_enabled: false,
            low_api_version: None,
            high_api_version: None,
        }
    }
}

impl ServerCapabilities {
    pub(crate) fn from_proto(proto: reapi::ServerCapabilities) -> Self {
        let cache = proto.cache_capabilities.unwrap_or_default();
        Self {
            digest_functions: cache
                .digest_functions
                .iter()
                .map(|value| digest_function_name(*value).to_string())
                .collect(),
            action_cache_update_enabled: cache
                .action_cache_update_capabilities
                .map(|update| update.update_enabled)
                .unwrap_or(false),
            max_batch_total_size_bytes: cache.max_batch_total_size_bytes,
            supported_compressors: cache
                .supported_compressors
                .iter()
                .map(|value| compressor_name(*value).to_string())
                .collect(),
            symlink_absolute_path_strategy: symlink_strategy_name(
                cache.symlink_absolute_path_strategy,
            )
            .to_string(),
            exec_enabled: proto
                .execution_capabilities
                .map(|exec| exec.exec_enabled)
                .unwrap_or(false),
            low_api_version: proto.low_api_version.map(api_version),
            high_api_version: proto.high_api_version.map(api_version),
        }
    }
}

fn api_version(version: protos::build::bazel::semver::SemVer) -> ApiVersion {
    ApiVersion {
        major: version.major,
        minor: version.minor,
        patch: version.patch,
    }
}

/// `DigestFunction.Value` numbers, per the REAPI proto.
fn digest_function_name(value: i32) -> &'static str {
    match value {
        0 => "UNKNOWN",
        1 => "SHA-256",
        2 => "SHA-1",
        3 => "MD5",
        4 => "VSO",
        5 => "SHA-384",
        6 => "SHA-512",
        7 => "MURMUR3",
        8 => "SHA-256/TREE",
        9 => "BLAKE3",
        _ => "OTHER",
    }
}

/// `Compressor.Value` numbers.
fn compressor_name(value: i32) -> &'static str {
    match value {
        0 => "IDENTITY",
        1 => "ZSTD",
        2 => "DEFLATE",
        3 => "BROTLI",
        _ => "OTHER",
    }
}

/// `SymlinkAbsolutePathStrategy.Value` numbers.
fn symlink_strategy_name(value: i32) -> &'static str {
    match value {
        0 => "UNKNOWN",
        1 => "DISALLOWED",
        2 => "ALLOWED",
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_names_match_the_reapi_numbering() {
        // The two this client can actually transfer with must be right, since
        // DigestFunction::to_proto depends on the same numbering.
        assert_eq!(digest_function_name(1), "SHA-256");
        assert_eq!(digest_function_name(9), "BLAKE3");
        assert_eq!(digest_function_name(8), "SHA-256/TREE");
        assert_eq!(digest_function_name(4242), "OTHER");

        assert_eq!(compressor_name(0), "IDENTITY");
        assert_eq!(compressor_name(1), "ZSTD");
        assert_eq!(compressor_name(4242), "OTHER");

        assert_eq!(symlink_strategy_name(1), "DISALLOWED");
        assert_eq!(symlink_strategy_name(2), "ALLOWED");
        assert_eq!(symlink_strategy_name(4242), "OTHER");
    }

    /// A server that reports nothing must flatten to defaults rather than
    /// panicking on absent sub-messages.
    #[test]
    fn empty_capabilities_flatten_to_defaults() {
        let caps = ServerCapabilities::from_proto(reapi::ServerCapabilities::default());
        assert_eq!(caps, ServerCapabilities::default());
        assert!(!caps.action_cache_update_enabled);
        assert!(!caps.exec_enabled);
        assert_eq!(caps.symlink_absolute_path_strategy, "UNKNOWN");
        assert_eq!(caps.low_api_version, None);
    }

    #[test]
    fn populated_capabilities_flatten_faithfully() {
        let proto = reapi::ServerCapabilities {
            cache_capabilities: Some(reapi::CacheCapabilities {
                digest_functions: vec![1, 9],
                action_cache_update_capabilities: Some(reapi::ActionCacheUpdateCapabilities {
                    update_enabled: true,
                }),
                max_batch_total_size_bytes: 4 * 1024 * 1024,
                supported_compressors: vec![0, 1],
                symlink_absolute_path_strategy: 2,
                ..Default::default()
            }),
            execution_capabilities: Some(reapi::ExecutionCapabilities {
                exec_enabled: true,
                ..Default::default()
            }),
            low_api_version: Some(protos::build::bazel::semver::SemVer {
                major: 2,
                minor: 0,
                patch: 0,
                ..Default::default()
            }),
            high_api_version: Some(protos::build::bazel::semver::SemVer {
                major: 2,
                minor: 3,
                patch: 0,
                ..Default::default()
            }),
            ..Default::default()
        };

        let caps = ServerCapabilities::from_proto(proto);
        assert_eq!(caps.digest_functions, vec!["SHA-256", "BLAKE3"]);
        assert!(caps.action_cache_update_enabled);
        assert_eq!(caps.max_batch_total_size_bytes, 4 * 1024 * 1024);
        assert_eq!(caps.supported_compressors, vec!["IDENTITY", "ZSTD"]);
        assert_eq!(caps.symlink_absolute_path_strategy, "ALLOWED");
        assert!(caps.exec_enabled);
        assert_eq!(caps.low_api_version.unwrap().to_string(), "2.0.0");
        assert_eq!(caps.high_api_version.unwrap().to_string(), "2.3.0");
    }
}
