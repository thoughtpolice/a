// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::*;

fn as_io(err: impl Into<io::Error>) -> io::Error {
    err.into()
}

#[tokio::test]
async fn waiting_for_a_relay_ends_when_the_endpoint_closes() {
    let endpoint = iroh_boring::builder()
        .relay_mode(iroh::RelayMode::Disabled)
        .bind()
        .await
        .expect("binding a relay-disabled endpoint");
    let waiting_endpoint = endpoint.clone();
    let waiting = tokio::spawn(async move { home_relay(&waiting_endpoint).await });

    tokio::task::yield_now().await;
    endpoint.close().await;

    let relay = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("home_relay stayed pending after the endpoint closed")
        .expect("home_relay task panicked");
    assert_eq!(relay, None);
}

#[test]
fn a_peer_reset_carries_its_code_through_io_error() {
    let code = VarInt::from_u32(7);
    assert_eq!(peer_code(&as_io(ReadError::Reset(code))), Some(code));
    assert_eq!(peer_code(&as_io(WriteError::Stopped(code))), Some(code));
    assert_eq!(peer_code(&io::Error::other("something else")), None);
    assert!(!is_normal_close(&as_io(ReadError::Reset(code))));
}

#[test]
fn a_finished_session_is_not_a_failure() {
    let done = ConnectionError::ApplicationClosed(iroh::endpoint::ApplicationClose {
        error_code: CLOSE_DONE,
        reason: b"done"[..].into(),
    });
    assert!(is_normal_close(&as_io(ReadError::ConnectionLost(done))));
    assert!(is_normal_close(&as_io(WriteError::ConnectionLost(
        ConnectionError::LocallyClosed
    ))));

    let refused = ConnectionError::ApplicationClosed(iroh::endpoint::ApplicationClose {
        error_code: VarInt::from_u32(1),
        reason: b"not allowed"[..].into(),
    });
    assert!(
        !is_normal_close(&as_io(ReadError::ConnectionLost(refused))),
        "a peer that closed with a reason of its own is not a clean end",
    );
    assert!(!is_normal_close(&as_io(ReadError::ConnectionLost(
        ConnectionError::TimedOut
    ))));
}
