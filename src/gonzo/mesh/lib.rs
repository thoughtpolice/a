// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! How gonzo daemons and their workers reach each other: [`iroh_mesh`],
//! with the daemon as its host and workers as its members, speaking
//! [`PROTOCOL`]. See `src/gonzo/notes/execution.md`.

pub use iroh_mesh::*;

/// What workers and daemons speak. Every field is wire format: changing
/// one strands every worker, ticket and join code in use.
pub const PROTOCOL: Protocol = Protocol {
    alpn: b"gonzo/worker/1",
    name: "gonzo",
    host: "daemon",
    member: "worker",
};

/// The ALPN workers dial daemons on.
pub const ALPN: &[u8] = PROTOCOL.alpn;
