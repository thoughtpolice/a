// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Protobuf files, reflected as a Rust module hierarchy. These basically map
//! 1-to-1 with the actual protobuf namespace.

// ---------------------------------------------------------------------------------------------------------------------

/// The encoded file descriptor set for gRPC reflection.
pub const FILE_DESCRIPTOR_SET: &[u8] =
    include_bytes!(concat!(env!("PROTOBUFS"), "/reapi_descriptor.bin"));

// ---------------------------------------------------------------------------------------------------------------------

pub mod google {
    pub mod api {
        include!(concat!(env!("PROTOBUFS"), "/google.api.rs"));
    }
    pub mod bytestream {
        include!(concat!(env!("PROTOBUFS"), "/google.bytestream.rs"));
    }
    pub mod longrunning {
        include!(concat!(env!("PROTOBUFS"), "/google.longrunning.rs"));
    }
    pub mod rpc {
        include!(concat!(env!("PROTOBUFS"), "/google.rpc.rs"));
    }
}

pub mod build {
    pub mod bazel {
        pub mod remote {
            pub mod execution {
                pub mod v2 {
                    include!(concat!(
                        env!("PROTOBUFS"),
                        "/build.bazel.remote.execution.v2.rs"
                    ));
                }
            }
        }

        pub mod semver {
            include!(concat!(env!("PROTOBUFS"), "/build.bazel.semver.rs"));
        }
    }
}
