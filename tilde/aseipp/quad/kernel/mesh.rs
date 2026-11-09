// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Editors and their clients over iroh: [`iroh_mesh`], with an editor as
//! its host and clients as its members, speaking [`PROTOCOL`].
//!
//! The editor's protocol (core/protocol.sls) runs over any byte stream, so
//! the network ends at a socketpair: each QUIC stream a client opens is
//! pumped to and from one end, and the editor's event loop serves the
//! other end's descriptor as it serves a Unix socket's. A client does the
//! same the other way round. The endpoints run on a Tokio runtime of their
//! own; descriptors reach Scheme through a [`Mailbox`].
//!
//! An editor is found by its six-word join code, which it announces
//! itself under on the mainline DHT, or by a ticket, which names its
//! endpoint and addresses. Both carry what a client proves it knows to be
//! admitted; both are credentials, and both are made up afresh each time
//! the editor starts listening, with a fresh identity, and kept nowhere:
//! once it stops, they are worth nothing. Clients take a fresh identity
//! each time too.

use std::os::fd::{FromRawFd as _, IntoRawFd as _, OwnedFd};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use accept::Accept as _;
use chez::{Mailbox, Sender};
use futures::StreamExt as _;
use iroh_mesh::{
    Announcer, Cluster, Endpoint, EndpointAddr, JoinCode, JoinKey, JoinTicket, Protocol, SecretKey,
    Transport,
};

/// What editors and their clients speak. Every field is wire format:
/// changing one strands every ticket and join code in use.
pub const PROTOCOL: Protocol = Protocol {
    alpn: b"quad/editor/1",
    name: "quad",
    host: "editor",
    member: "client",
};

/// How long a client looks on the DHT for an editor by its code.
const LOOK_FOR: Duration = Duration::from_secs(10);

/// How long an editor waits for its relay before making its ticket.
const RELAY_WAIT: Duration = Duration::from_secs(3);

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("quad-mesh")
            .enable_all()
            .build()
            .expect("a Tokio runtime for iroh")
    })
}

/// Relays and every address lookup, or (`local`) none: then only the
/// addresses a ticket carries reach an endpoint, as in tests.
fn preset(local: bool) -> iroh_dial::Global {
    if local {
        iroh_dial::Global::none()
    } else {
        iroh_dial::Global::default()
    }
}

/// Pump `stream` to and from one end of a new socketpair, until either
/// side ends; the other end's descriptor, which the caller now owns.
fn bridge<S>(stream: S) -> std::io::Result<i32>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
    ours.set_nonblocking(true)?;
    let mut stream = stream;
    runtime().spawn(async move {
        let Ok(mut ours) = tokio::net::UnixStream::from_std(ours) else {
            return;
        };
        let _ = tokio::io::copy_bidirectional(&mut ours, &mut stream).await;
    });
    Ok(theirs.into_raw_fd())
}

// ---------------------------------------------------------------------------
// Editors

/// What an editor's endpoint has made known so far.
#[derive(Default)]
pub struct HostInfo {
    pub id: Option<String>,
    pub ticket: Option<String>,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// An editor accepting clients over iroh, until dropped.
pub struct Host {
    /// Each client stream's descriptor; -1 when the info changes.
    pub streams: Mailbox<i32>,
    pub info: Arc<Mutex<HostInfo>>,
    endpoint: Arc<Mutex<Option<Endpoint>>>,
    _announcer: Arc<Mutex<Option<Announcer>>>,
}

impl Drop for Host {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.lock().unwrap().take() {
            runtime().spawn(async move { endpoint.close().await });
        }
    }
}

/// Accept clients that know a new join key, the ticket's, or (with
/// `code?`) the key of a new join code, which the editor also announces
/// itself under. The editor's ticket and code arrive in its info as they
/// are ready; so does what failed.
pub fn host(code: bool, local: bool) -> std::io::Result<Host> {
    let (tx, streams) = Mailbox::new()?;
    let info = Arc::new(Mutex::new(HostInfo::default()));
    let endpoint_slot = Arc::new(Mutex::new(None));
    let announcer_slot = Arc::new(Mutex::new(None));
    let identity = SecretKey::generate();
    let key = JoinKey::generate();
    let code = code.then(JoinCode::generate);
    {
        let (info, endpoint_slot, announcer_slot) =
            (info.clone(), endpoint_slot.clone(), announcer_slot.clone());
        runtime().spawn(async move {
            let endpoint = match PROTOCOL
                .bind_host(identity, preset(local), &Transport::default())
                .await
            {
                Ok(endpoint) => endpoint,
                Err(e) => {
                    return failed(&info, &tx, format!("the iroh endpoint would not bind: {e}"));
                }
            };
            *endpoint_slot.lock().unwrap() = Some(endpoint.clone());
            if !local {
                // A ticket carrying the editor's relay reaches it even where
                // address lookup does not.
                let _ = tokio::time::timeout(RELAY_WAIT, endpoint.online()).await;
            }
            {
                let mut i = info.lock().unwrap();
                i.id = Some(endpoint.id().to_string());
                i.ticket = Some(
                    JoinTicket {
                        host: endpoint.addr(),
                        key: key.clone(),
                    }
                    .to_string(),
                );
            }
            let _ = tx.send(-1);
            let mut keys = vec![key];
            if let Some(code) = code {
                // Slow on purpose: see iroh_mesh::JoinCode.
                let text = code.to_string();
                match tokio::task::spawn_blocking(move || code.cluster(&PROTOCOL)).await {
                    Ok(cluster) => {
                        keys.push(cluster.key());
                        // Without the DHT (local), nobody can find the
                        // editor by its code, so it is not offered.
                        if !local {
                            match Cluster::rendezvous(&endpoint, None) {
                                Ok(rendezvous) => {
                                    // The code is offered once the DHT has
                                    // the editor under it: a client that
                                    // tries it then finds the editor.
                                    if let Err(e) = cluster.announce_once(&rendezvous).await {
                                        failed(
                                            &info,
                                            &tx,
                                            format!("announcing the editor on the DHT: {e}"),
                                        );
                                    } else {
                                        info.lock().unwrap().code = Some(text);
                                        let _ = tx.send(-1);
                                    }
                                    *announcer_slot.lock().unwrap() =
                                        Some(cluster.announce(&rendezvous));
                                }
                                Err(e) => failed(
                                    &info,
                                    &tx,
                                    format!("could not join the DHT to announce the editor: {e}"),
                                ),
                            }
                        }
                    }
                    Err(e) => failed(&info, &tx, format!("the join code: {e}")),
                }
            }
            serve(PROTOCOL.serve(endpoint, keys), tx).await;
        });
    }
    Ok(Host {
        streams,
        info,
        endpoint: endpoint_slot,
        _announcer: announcer_slot,
    })
}

fn failed(info: &Mutex<HostInfo>, tx: &Sender<i32>, what: String) {
    info.lock().unwrap().error = Some(what);
    let _ = tx.send(-1);
}

/// Hand each admitted client's streams to Scheme, as descriptors.
async fn serve(mut streams: accept::Handover<iroh_mesh::Stream>, tx: Sender<i32>) {
    while let Ok(Some(stream)) = streams.accept().await {
        // A stream that cannot be bridged (out of descriptors) is dropped,
        // which the client sees as a closed connection.
        if let Ok(fd) = bridge(stream) {
            if tx.send(fd).is_err() {
                // The editor stopped listening.
                drop(unsafe { OwnedFd::from_raw_fd(fd) });
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Clients

/// A client's connection to an editor, open until dropped.
pub struct Session {
    pub fd: i32,
    pub editor: String,
    endpoint: Option<Endpoint>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            runtime().spawn(async move { endpoint.close().await });
        }
    }
}

/// What `target` names: a join code, a ticket, or neither.
pub fn target_kind(target: &str) -> Option<&'static str> {
    if target.parse::<JoinTicket>().is_ok() {
        Some("ticket")
    } else if target.parse::<JoinCode>().is_ok() {
        Some("code")
    } else {
        None
    }
}

/// Connect to the editor `target` names, a join code or a ticket: a
/// stream to it, as a descriptor. Under a code, each editor is tried as
/// soon as the DHT mentions it, rather than once the whole lookup is done.
pub fn connect(target: &str, local: bool) -> Result<Session, String> {
    let identity = SecretKey::generate();
    let target = target.to_string();
    runtime().block_on(async move {
        let endpoint = PROTOCOL
            .bind_member(identity, preset(local), &Transport::default())
            .await
            .map_err(|e| format!("the iroh endpoint would not bind: {e}"))?;
        let attempt = |addr: EndpointAddr, key: JoinKey| {
            let endpoint = endpoint.clone();
            async move {
                let conn = iroh_dial::dial(&endpoint, addr.into(), PROTOCOL.alpn)
                    .await
                    .map_err(|e| e.to_string())?;
                PROTOCOL
                    .join(&conn, endpoint.id(), &key)
                    .await
                    .map_err(|e| e.to_string())?;
                let (send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
                let fd = bridge(tokio::io::join(recv, send)).map_err(|e| e.to_string())?;
                Ok::<_, String>((fd, conn.remote_id().to_string()))
            }
        };
        let mut why = String::new();
        if let Ok(ticket) = target.parse::<JoinTicket>() {
            match attempt(ticket.host, ticket.key).await {
                Ok((fd, editor)) => {
                    return Ok(Session {
                        fd,
                        editor,
                        endpoint: Some(endpoint),
                    });
                }
                Err(e) => why = e,
            }
        } else if let Ok(code) = target.parse::<JoinCode>() {
            // The DHT node finds its way around while Argon2 runs.
            let rendezvous = Cluster::rendezvous(&endpoint, None)
                .map_err(|e| format!("could not join the DHT: {e}"))?;
            let cluster = tokio::task::spawn_blocking(move || code.cluster(&PROTOCOL))
                .await
                .map_err(|e| e.to_string())?;
            // An editor that has only just started may not be on the DHT
            // yet: look again, for a while.
            let deadline = tokio::time::Instant::now() + LOOK_FOR;
            let mut tried = std::collections::HashSet::new();
            loop {
                let mut hosts = cluster
                    .host_stream(&rendezvous)
                    .await
                    .map_err(|e| format!("looking for the editor on the DHT: {e}"))?;
                while let Some(id) = hosts.next().await {
                    if !tried.insert(id) {
                        continue;
                    }
                    match attempt(EndpointAddr::new(id), cluster.key()).await {
                        Ok((fd, editor)) => {
                            return Ok(Session {
                                fd,
                                editor,
                                endpoint: Some(endpoint),
                            });
                        }
                        Err(e) => why = e,
                    }
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            if tried.is_empty() {
                endpoint.close().await;
                return Err(format!("no editor is announced under {}", cluster.hint()));
            }
        } else {
            return Err(format!("{target:?} is neither a join code nor a ticket"));
        }
        endpoint.close().await;
        Err(format!("could not reach the editor: {why}"))
    })
}
