// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! gonzo's own protocols, beside the REAPI ones in the `protos` crate.

/// The encoded file descriptor set, for gRPC reflection.
pub const FILE_DESCRIPTOR_SET: &[u8] =
    include_bytes!(concat!(env!("PROTOBUFS"), "/gonzo_descriptor.bin"));

pub mod worker {
    pub mod v1 {
        include!(concat!(env!("PROTOBUFS"), "/gonzo.worker.v1.rs"));
    }
}
