// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The join handshake, on the first stream of a member's connection.
//!
//! iroh authenticates each end of a connection as its endpoint ID, so what
//! is left is whether each may talk to the other. The member sends a proof
//! that it knows the join key, bound to both IDs; the host checks it
//! against the keys it accepts and answers with a proof of its own, which
//! the member checks. A peer without the key learns nothing it could
//! replay: proofs name the IDs of the two ends of this connection, and the
//! [`Protocol`] they were made for.

use std::time::Duration;

use iroh::EndpointId;
use iroh::endpoint::{Connection, ConnectionError, VarInt};

use crate::Protocol;
use crate::keys::JoinKey;

/// How long either side waits for the other's half of the handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// How a host closes a connection whose member could not prove it knows a
/// join key.
pub const CLOSE_REFUSED: VarInt = VarInt::from_u32(1);

/// Why a handshake failed.
#[derive(Debug, thiserror::Error)]
pub enum JoinError {
    #[error("the member does not know a join key this host accepts")]
    UnknownMember,
    #[error("the host could not prove it knows the join key; it is not the host the key is for")]
    UnknownHost,
    #[error("the handshake took longer than {HANDSHAKE_TIMEOUT:?}")]
    TimedOut,
    #[error("the handshake failed: {0}")]
    Connection(String),
}

impl JoinError {
    fn connection(e: impl std::fmt::Display) -> Self {
        Self::Connection(e.to_string())
    }
}

/// The proof that whoever plays `role` on the connection between `host`
/// and `member` knows `key`.
pub(crate) fn proof(
    protocol: &Protocol,
    key: &JoinKey,
    role: &str,
    host: EndpointId,
    member: EndpointId,
) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new_keyed(&key.0);
    hasher.update(protocol.name.as_bytes());
    hasher.update(b" join v1 ");
    hasher.update(role.as_bytes());
    hasher.update(host.as_bytes());
    hasher.update(member.as_bytes());
    hasher.finalize()
}

/// Whether `reason` is a host's refusal.
fn refused(reason: Option<ConnectionError>) -> bool {
    matches!(reason, Some(ConnectionError::ApplicationClosed(close)) if close.error_code == CLOSE_REFUSED)
}

/// What the other end sent: one proof, and nothing else.
fn read_proof(bytes: Vec<u8>) -> Option<blake3::Hash> {
    <[u8; 32]>::try_from(bytes)
        .ok()
        .map(blake3::Hash::from_bytes)
}

impl Protocol {
    /// Join the host at the other end of `conn`, as the member `me`.
    pub async fn join(
        &self,
        conn: &Connection,
        me: EndpointId,
        key: &JoinKey,
    ) -> Result<(), JoinError> {
        let host = conn.remote_id();
        let handshake = async {
            let (mut send, mut recv) = conn.open_bi().await.map_err(JoinError::connection)?;
            send.write_all(proof(self, key, self.member, host, me).as_bytes())
                .await
                .map_err(JoinError::connection)?;
            send.finish().map_err(JoinError::connection)?;
            let reply = match recv.read_to_end(64).await {
                Ok(reply) if !reply.is_empty() => reply,
                // A host that refuses closes the connection, saying why. The
                // stream it drops ends empty, and that end may arrive first.
                Ok(_) if refused(Some(conn.closed().await)) => {
                    return Err(JoinError::UnknownMember);
                }
                Ok(_) => return Err(JoinError::UnknownHost),
                Err(_) if refused(conn.close_reason()) => return Err(JoinError::UnknownMember),
                Err(e) => return Err(JoinError::connection(e)),
            };
            match read_proof(reply) {
                Some(answer) if answer == proof(self, key, self.host, host, me) => Ok(()),
                _ => Err(JoinError::UnknownHost),
            }
        };
        tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
            .await
            .unwrap_or(Err(JoinError::TimedOut))
    }

    /// Admit the member at the other end of `conn` to the host `me`, if it
    /// proves it knows one of `keys`. A member that cannot is sent away.
    pub async fn admit(
        &self,
        conn: &Connection,
        me: EndpointId,
        keys: &[JoinKey],
    ) -> Result<(), JoinError> {
        let member = conn.remote_id();
        let handshake = async {
            let (mut send, mut recv) = conn.accept_bi().await.map_err(JoinError::connection)?;
            let offered = recv.read_to_end(64).await.map_err(JoinError::connection)?;
            let key = read_proof(offered)
                .and_then(|offered| {
                    keys.iter()
                        .find(|key| proof(self, key, self.member, me, member) == offered)
                })
                .ok_or(JoinError::UnknownMember)?;
            send.write_all(proof(self, key, self.host, me, member).as_bytes())
                .await
                .map_err(JoinError::connection)?;
            send.finish().map_err(JoinError::connection)
        };
        let result = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)
            .await
            .unwrap_or(Err(JoinError::TimedOut));
        if result.is_err() {
            conn.close(CLOSE_REFUSED, b"not admitted");
        }
        result
    }
}
