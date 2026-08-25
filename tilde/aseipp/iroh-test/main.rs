// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! End-to-end proof that iroh runs on our BoringSSL rustls provider.
//!
//! With no arguments this spins up endpoint pairs in one process, connects
//! them directly over loopback (no relays, no discovery), and echoes a
//! payload across the encrypted QUIC connection — a complete TLS 1.3
//! raw-public-key handshake and AES-GCM packet protection, all through
//! BoringSSL. The provider prefers the X25519MLKEM768 hybrid, so the
//! default handshake is post-quantum; three self-test phases prove the
//! preference and both boundary cases:
//!
//! 1. default providers — negotiates X25519MLKEM768;
//! 2. hybrid-only on both sides — succeeding without any fallback group
//!    proves the post-quantum exchange end-to-end over real QUIC packets;
//! 3. classical-only server — the client falls back to plain X25519 with
//!    no extra round trip.
//!
//! The client reports what each connection actually negotiated. iroh does
//! not surface the TLS session, so the key exchange is observed at the
//! source: the client's crypto provider is wrapped to record which group
//! completed (see [`KxWitness`]), and path/RTT details come from
//! [`Connection::paths`].
//!
//! `serve` hosts a standalone echo server registered with n0's public relay
//! and address-lookup infrastructure, so it is dialable from anywhere by
//! endpoint ID alone: `connect <endpoint-id>`. Only outbound connectivity is
//! required on either side — no public IP, no open inbound ports. A socket
//! address may be passed to `connect` as a hint for direct/LAN dialing.

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use iroh::address_lookup::{DnsAddressLookup, PkarrPublisher, PkarrResolver};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode};
use iroh_utils::{RELAY_TIMEOUT, dialable_addr, dialable_addrs};
use rustls::crypto::{
    ActiveKeyExchange, CompletedKeyExchange, CryptoProvider, SharedSecret, SupportedKxGroup,
};
use rustls::ffdhe_groups::FfdheGroup;
use rustls::{NamedGroup, ProtocolVersion};

const ALPN: &[u8] = b"depot/iroh-test/0";
const PAYLOAD: &[u8] = b"jumped over the lazy dog, encrypted by BoringSSL";
const USAGE: &str = "usage: iroh-test [serve | connect <endpoint-id> [addr]]";

/// Binds an endpoint registered with n0's public infrastructure: their
/// default relay servers, plus address publishing and lookup through the
/// iroh.link DNS service. Endpoints bound this way are dialable from
/// anywhere by endpoint ID alone — only outbound connectivity is needed,
/// so this works behind NAT and HTTP-only ingress.
///
/// This recreates `presets::N0`, which is unavailable to us: it is
/// feature-gated on iroh's bundled ring/aws-lc-rs TLS stacks, and we build
/// with those disabled in favor of BoringSSL. Like the preset (since iroh
/// 1.0.3), lookups go through both the pkarr relay over HTTPS and DNS.
async fn bind_public_endpoint(provider: Arc<CryptoProvider>, alpns: bool) -> Result<Endpoint> {
    // `iroh_boring::builder_with` installs the plain provider as the
    // process default for unrelated handshakes (DoH, relay HTTP), so those
    // cannot overwrite what this connection's witness records.
    let mut builder = iroh_boring::builder_with(provider)
        .address_lookup(PkarrPublisher::n0_dns())
        .address_lookup(PkarrResolver::n0_dns())
        .address_lookup(DnsAddressLookup::n0_dns())
        .relay_mode(RelayMode::Default);
    if alpns {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    Ok(builder.bind().await?)
}

async fn bind_endpoint_with(provider: Arc<CryptoProvider>, alpns: bool) -> Result<Endpoint> {
    // No relays and no address lookup, so these endpoints are reachable
    // only at the addresses they are bound to.
    let mut builder = iroh_boring::builder_with(provider);
    if alpns {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    Ok(builder.bind().await?)
}

/// The BoringSSL provider restricted to the given key exchange groups.
/// With `X25519MLKEM768` alone a handshake cannot fall back, so success
/// proves the post-quantum exchange ran.
fn provider_with_kx(kx_groups: Vec<&'static dyn SupportedKxGroup>) -> CryptoProvider {
    CryptoProvider {
        kx_groups,
        ..rustls_boring::provider()
    }
}

/// Records the key exchange group of the most recently completed handshake
/// on a monitored provider (last write wins), for reporting what a
/// connection actually negotiated.
#[derive(Clone, Debug, Default)]
struct KxWitness(Arc<Mutex<Option<NamedGroup>>>);

impl KxWitness {
    fn record(&self, group: NamedGroup) {
        *self.0.lock().expect("kx witness lock") = Some(group);
    }

    fn group(&self) -> Option<NamedGroup> {
        *self.0.lock().expect("kx witness lock")
    }

    fn describe(&self) -> String {
        match self.group() {
            Some(NamedGroup::X25519MLKEM768) => "X25519MLKEM768 (hybrid post-quantum)".into(),
            Some(group) => format!("{group:?} (classical)"),
            None => "unknown (no key exchange recorded)".into(),
        }
    }
}

/// Wrap every key exchange group of `base` so completed handshakes are
/// recorded into the returned [`KxWitness`]. rustls wants `&'static`
/// groups, so the handful of small wrappers a demo process creates are
/// leaked.
fn monitored_provider(base: CryptoProvider) -> (Arc<CryptoProvider>, KxWitness) {
    let witness = KxWitness::default();
    let kx_groups = base
        .kx_groups
        .iter()
        .map(|&inner| {
            &*Box::leak(Box::new(RecordingKxGroup {
                inner,
                witness: witness.clone(),
            })) as &'static dyn SupportedKxGroup
        })
        .collect();
    (Arc::new(CryptoProvider { kx_groups, ..base }), witness)
}

#[derive(Debug)]
struct RecordingKxGroup {
    inner: &'static dyn SupportedKxGroup,
    witness: KxWitness,
}

impl SupportedKxGroup for RecordingKxGroup {
    fn name(&self) -> NamedGroup {
        self.inner.name()
    }

    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, rustls::Error> {
        Ok(Box::new(RecordingKx {
            inner: self.inner.start()?,
            witness: self.witness.clone(),
        }))
    }

    /// The server side of a KEM exchange; recorded for symmetry even
    /// though the demo only reports from clients.
    fn start_and_complete(
        &self,
        peer_pub_key: &[u8],
    ) -> Result<CompletedKeyExchange, rustls::Error> {
        let completed = self.inner.start_and_complete(peer_pub_key)?;
        self.witness.record(completed.group);
        Ok(completed)
    }

    fn ffdhe_group(&self) -> Option<FfdheGroup<'static>> {
        self.inner.ffdhe_group()
    }

    fn fips(&self) -> bool {
        self.inner.fips()
    }

    fn usable_for_version(&self, version: ProtocolVersion) -> bool {
        self.inner.usable_for_version(version)
    }
}

struct RecordingKx {
    inner: Box<dyn ActiveKeyExchange>,
    witness: KxWitness,
}

// `complete_for_tls_version` is deliberately not forwarded: its default
// implementation dispatches to `complete` on this wrapper, keeping the
// recording intact.
impl ActiveKeyExchange for RecordingKx {
    fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, rustls::Error> {
        let this = *self;
        let group = this.inner.group();
        let secret = this.inner.complete(peer_pub_key)?;
        this.witness.record(group);
        Ok(secret)
    }

    fn hybrid_component(&self) -> Option<(NamedGroup, &[u8])> {
        self.inner.hybrid_component()
    }

    /// The server chose the classical component of a hybrid offer.
    fn complete_hybrid_component(
        self: Box<Self>,
        peer_pub_key: &[u8],
    ) -> Result<SharedSecret, rustls::Error> {
        let this = *self;
        let component = this.inner.hybrid_component().map(|(group, _)| group);
        let secret = this.inner.complete_hybrid_component(peer_pub_key)?;
        if let Some(group) = component {
            this.witness.record(group);
        }
        Ok(secret)
    }

    fn pub_key(&self) -> &[u8] {
        self.inner.pub_key()
    }

    fn ffdhe_group(&self) -> Option<FfdheGroup<'static>> {
        self.inner.ffdhe_group()
    }

    fn group(&self) -> NamedGroup {
        self.inner.group()
    }
}

async fn echo_conn(conn: Connection) -> Result<()> {
    println!(
        "[server] connection from {} (ALPN {:?})",
        conn.remote_id().fmt_short(),
        String::from_utf8_lossy(conn.alpn()),
    );
    let (mut send, mut recv) = conn.accept_bi().await?;
    let data = recv.read_to_end(64 * 1024).await?;
    println!("[server] echoing {} bytes", data.len());
    send.write_all(&data).await?;
    send.finish()?;
    // Wait for the peer to close so the data is flushed before we drop.
    conn.closed().await;
    Ok(())
}

async fn echo_server(endpoint: Endpoint) -> Result<()> {
    let Some(incoming) = endpoint.accept().await else {
        bail!("endpoint closed before accepting a connection");
    };
    let conn = incoming.await.context("accepting connection")?;
    echo_conn(conn).await
}

async fn serve() -> Result<()> {
    let endpoint = bind_public_endpoint(rustls_boring::arc_provider(), true).await?;
    println!("[server] id {}", endpoint.id());
    println!("[server] local sockets {:?}", dialable_addrs(&endpoint));
    match tokio::time::timeout(RELAY_TIMEOUT, iroh_utils::home_relay(&endpoint)).await {
        Ok(Some(relay)) => println!("[server] home relay {relay}"),
        _ => {
            println!("[server] no relay connection after {RELAY_TIMEOUT:?}; only directly dialable")
        }
    }
    println!("[server] dial with: iroh-test connect {}", endpoint.id());
    // Serve until killed, one task per connection so clients can overlap.
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(err) => {
                    eprintln!("[server] failed to accept connection: {err:#}");
                    return;
                }
            };
            if let Err(err) = echo_conn(conn).await {
                eprintln!("[server] connection failed: {err:#}");
            }
        });
    }
    Ok(())
}

async fn run_client(endpoint: &Endpoint, addr: EndpointAddr, kx: &KxWitness) -> Result<()> {
    let conn = endpoint.connect(addr, ALPN).await?;
    println!(
        "[client] connected to {} (ALPN {:?})",
        conn.remote_id().fmt_short(),
        String::from_utf8_lossy(conn.alpn()),
    );
    // Read the witness immediately: the p2p handshake that `connect`
    // awaited is the provider's most recent, so a later relay reconnect
    // cannot have overwritten it yet.
    println!("[client] key exchange: {}", kx.describe());

    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(PAYLOAD).await?;
    send.finish()?;
    let echoed = recv.read_to_end(64 * 1024).await?;

    for path in &conn.paths() {
        println!(
            "[client] path {} ({}{}) rtt {:?}",
            path.remote_addr(),
            if path.is_relay() { "relay" } else { "direct" },
            if path.is_selected() { ", selected" } else { "" },
            path.rtt(),
        );
    }
    conn.close(0u32.into(), b"done");

    if echoed != PAYLOAD {
        bail!("echoed payload does not match what we sent");
    }
    println!("[client] payload of {} bytes echoed intact", echoed.len());
    Ok(())
}

/// Echo one payload from `client` through `server` and close both ends.
async fn echo_pair(server: Endpoint, client: Endpoint, kx: &KxWitness) -> Result<()> {
    let server_addr = dialable_addr(&server);
    println!(
        "[server] id {} listening on {:?}",
        server.id().fmt_short(),
        dialable_addrs(&server)
    );

    let server_task = tokio::spawn(echo_server(server.clone()));
    run_client(&client, server_addr, kx).await?;
    server_task.await??;

    client.close().await;
    server.close().await;
    Ok(())
}

fn expect_kx(kx: &KxWitness, want: NamedGroup) -> Result<()> {
    let got = kx.group();
    if got != Some(want) {
        bail!("expected key exchange {want:?}, but negotiated {got:?}");
    }
    Ok(())
}

async fn self_test() -> Result<()> {
    println!("[self-test] phase 1: default providers, post-quantum preferred");
    let (provider, kx) = monitored_provider(rustls_boring::provider());
    let server = bind_endpoint_with(rustls_boring::arc_provider(), true).await?;
    let client = bind_endpoint_with(provider, false).await?;
    echo_pair(server, client, &kx).await?;
    expect_kx(&kx, NamedGroup::X25519MLKEM768)?;
    println!("self-test OK: iroh negotiates post-quantum by default");

    println!("[self-test] phase 2: hybrid-only providers, no fallback possible");
    let hybrid_only = || provider_with_kx(vec![rustls_boring::kx_group::X25519MLKEM768]);
    let (provider, kx) = monitored_provider(hybrid_only());
    let server = bind_endpoint_with(Arc::new(hybrid_only()), true).await?;
    let client = bind_endpoint_with(provider, false).await?;
    echo_pair(server, client, &kx).await?;
    expect_kx(&kx, NamedGroup::X25519MLKEM768)?;
    println!("self-test OK: X25519MLKEM768 with nothing to fall back to");

    println!("[self-test] phase 3: post-quantum client, classical-only server");
    let (provider, kx) = monitored_provider(rustls_boring::provider());
    let server = bind_endpoint_with(
        Arc::new(provider_with_kx(vec![rustls_boring::kx_group::X25519])),
        true,
    )
    .await?;
    let client = bind_endpoint_with(provider, false).await?;
    echo_pair(server, client, &kx).await?;
    expect_kx(&kx, NamedGroup::X25519)?;
    println!("self-test OK: classical fallback works without a retry");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => self_test().await,
        Some("serve") => serve().await,
        Some("connect") => {
            let id = args
                .get(1)
                .with_context(|| format!("missing endpoint ID; {USAGE}"))?;
            let id: EndpointId = id.parse().context("parsing endpoint ID")?;
            let mut endpoint_addr = EndpointAddr::new(id);
            if let Some(addr) = args.get(2) {
                let sock: SocketAddr = addr.parse().context("parsing socket address")?;
                endpoint_addr = endpoint_addr.with_ip_addr(sock);
            }
            let (provider, kx) = monitored_provider(rustls_boring::provider());
            let endpoint = bind_public_endpoint(provider, false).await?;
            run_client(&endpoint, endpoint_addr, &kx).await?;
            endpoint.close().await;
            Ok(())
        }
        Some(other) => bail!("unknown command {other:?}; {USAGE}"),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn iroh_echo_over_boringssl_provider() {
        super::self_test().await.expect("self test failed");
    }
}
