// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Application-specific iroh endpoint construction.

use std::collections::BTreeSet;

use anyhow::Result;
use burrow_core::protocol::ALPN;
use iroh::endpoint::{
    AfterHandshakeOutcome, Connection, EndpointHooks, NetReportConfig, PortmapperConfig,
    QuicTransportConfig, VarInt,
};
use iroh::{Endpoint, EndpointId, RelayMode, SecretKey};
use tracing::debug;

/// A peer may have this many request streams active on one connection.
pub(crate) const MAX_STREAMS_PER_CONNECTION: u32 = 64;

/// The application close used when an authenticated peer is not authorized.
pub(crate) const CLOSE_NOT_ALLOWED: VarInt = VarInt::from_u32(1);

#[derive(Debug)]
struct Allowlist(BTreeSet<EndpointId>);

impl EndpointHooks for Allowlist {
    async fn after_handshake(&self, conn: &Connection) -> AfterHandshakeOutcome {
        let remote = conn.remote_id();
        if self.0.contains(&remote) {
            return AfterHandshakeOutcome::Accept;
        }
        // This hook runs before application admission and can be reached by
        // arbitrary authenticated iroh identities. Keep refusal telemetry at
        // debug level so an attacker cannot amplify ordinary WARN logs.
        debug!(%remote, "refused an endpoint that is not on the allowlist");
        AfterHandshakeOutcome::Reject {
            error_code: CLOSE_NOT_ALLOWED,
            reason: b"not allowed".to_vec(),
        }
    }
}

pub(crate) enum Role {
    Client,
    Server(BTreeSet<EndpointId>),
}

/// Binds an endpoint without discovery publication or automatic port mapping.
///
/// HTTPS relay probes stay enabled: they are what let iroh distinguish a
/// usable HTTPS relay path on networks that block UDP.
pub(crate) async fn bind(key: SecretKey, relay: RelayMode, role: Role) -> Result<Endpoint> {
    let incoming_bidi = match &role {
        Role::Client => 0,
        Role::Server(_) => MAX_STREAMS_PER_CONNECTION,
    };
    let transport = QuicTransportConfig::builder()
        .max_concurrent_bidi_streams(VarInt::from_u32(incoming_bidi))
        .max_concurrent_uni_streams(VarInt::from_u32(0))
        .build();
    let mut net_report = NetReportConfig::minimal();
    net_report.https_probes = true;

    let mut builder = iroh_boring::builder()
        .secret_key(key)
        .relay_mode(relay)
        .portmapper_config(PortmapperConfig::Disabled)
        .net_report_config(net_report)
        .transport_config(transport);
    if let Role::Server(allow) = role {
        builder = builder.alpns(vec![ALPN.to_vec()]).hooks(Allowlist(allow));
    }
    Ok(builder.bind().await?)
}
