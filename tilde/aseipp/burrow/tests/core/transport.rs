// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

use futures::future::join_all;
use iroh::endpoint::{ReadError, ReadToEndError};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const PATIENCE: Duration = Duration::from_secs(10);

async fn echo_server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = stream.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    address
}

async fn raw_opened_stream() -> (
    Endpoint,
    Endpoint,
    Client,
    OpenedStream,
    Connection,
    SendStream,
    RecvStream,
) {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        let connection = accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection");
        let (mut send, mut recv) = connection
            .accept_bi()
            .await
            .expect("accepting the test stream");
        assert_eq!(
            protocol::read_request(&mut recv).await.unwrap(),
            Request::Connect(Target::Default)
        );
        protocol::write_response(&mut send, &Response::ok())
            .await
            .unwrap();
        (connection, send, recv)
    });
    let client = Client::new(client_endpoint.clone(), server_addr);
    let opened = client
        .open(Target::Default)
        .await
        .expect("opening the test stream");
    let (connection, send, recv) = accepting.await.expect("accept task panicked");
    (
        client_endpoint,
        server_endpoint,
        client,
        opened,
        connection,
        send,
        recv,
    )
}

#[tokio::test]
async fn cancelling_request_before_ack_aborts_both_stream_halves() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        let connection = accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection");
        let (send, mut recv) = connection
            .accept_bi()
            .await
            .expect("accepting the test stream");
        assert_eq!(
            protocol::read_request(&mut recv).await.unwrap(),
            Request::Connect(Target::Default)
        );
        (connection, send, recv)
    });

    let client = Client::new(client_endpoint.clone(), server_addr);
    let opening_client = client.clone();
    let opening = tokio::spawn(async move { opening_client.open(Target::Default).await });
    let (server_connection, mut peer_send, mut peer_recv) =
        tokio::time::timeout(PATIENCE, accepting)
            .await
            .expect("the request did not reach the manual peer")
            .expect("the accept task panicked");

    opening.abort();
    assert!(
        opening
            .await
            .expect_err("the open task was not cancelled")
            .is_cancelled(),
        "the open task failed for a reason other than cancellation"
    );

    match tokio::time::timeout(PATIENCE, peer_recv.read_to_end(1024))
        .await
        .expect("the peer receive half stayed pending")
    {
        Err(ReadToEndError::Read(ReadError::Reset(code))) => assert_eq!(code, RESET_ABORTED),
        other => panic!("expected reset {RESET_ABORTED}, got {other:?}"),
    }
    assert_eq!(
        tokio::time::timeout(PATIENCE, peer_send.stopped())
            .await
            .expect("the peer send half stayed pending")
            .expect("checking whether the peer stopped the stream"),
        Some(RESET_ABORTED),
    );
    assert!(
        server_connection.close_reason().is_none(),
        "cancelling one request closed the shared connection"
    );

    client.close().await;
    server_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn cancelling_completed_dial_before_state_lock_uses_nonzero_close() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection")
    });

    let client = Client::new(client_endpoint.clone(), server_addr);
    let dialing_client = client.clone();
    let dialing = tokio::spawn(async move { dialing_client.connection().await });

    // Seize the state lock after connection() publishes its shared dial,
    // then keep it held until that dial has completed. This forces the
    // spawned waiter into the cancellation window between `dial.await`
    // and reacquiring state.
    let state = tokio::time::timeout(PATIENCE, async {
        loop {
            let state = client.0.state.lock().await;
            if state.dialing.is_some() {
                break state;
            }
            drop(state);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the client did not publish its dial attempt");
    let peer = tokio::time::timeout(PATIENCE, accepting)
        .await
        .expect("the peer did not complete the handshake")
        .expect("the accept task panicked");
    tokio::time::timeout(PATIENCE, async {
        loop {
            let attempt = state.dialing.as_ref().expect("the dial attempt vanished");
            if attempt.future.peek().is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the client-side dial did not complete");

    dialing.abort();
    assert!(
        dialing
            .await
            .expect_err("the dial task was not cancelled")
            .is_cancelled(),
        "the dial task failed for a reason other than cancellation"
    );
    drop(state);
    drop(client);

    match tokio::time::timeout(PATIENCE, peer.closed())
        .await
        .expect("the unclaimed connection did not close")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_RETIRED)
        }
        other => panic!("expected an explicit retired close, got {other:?}"),
    }

    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[test]
fn client_diagnostics_are_bounded_and_terminal_safe() {
    let untrusted = format!(
        "line\n\x1b[31m\u{202e}{}",
        "x".repeat(protocol::MAX_RESPONSE_BYTES + 100)
    );
    let constructed = ClientError::transport(&untrusted);
    let ClientError::Transport(stored) = &constructed else {
        unreachable!()
    };
    assert!(stored.len() <= protocol::MAX_RESPONSE_BYTES);
    assert!(stored.ends_with('…'));

    for error in [constructed, ClientError::Dial(untrusted)] {
        let displayed = error.to_string();
        assert!(displayed.contains(r"line\n\u{1b}[31m\u{202e}"));
        assert!(
            !displayed.chars().any(|ch| {
                ch.is_control()
                    || matches!(
                        ch,
                        '\u{061c}'
                            | '\u{200e}'..='\u{200f}'
                            | '\u{202a}'..='\u{202e}'
                            | '\u{2066}'..='\u{2069}'
                    )
            }),
            "unsafe diagnostic reached Display: {displayed:?}"
        );
        assert!(
            displayed.len() <= protocol::MAX_RESPONSE_BYTES + 64,
            "diagnostic was not bounded"
        );
    }
}

#[tokio::test]
async fn client_multiplexes_requests_and_server_shutdown_is_not_clean() {
    let target = echo_server().await;
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);

    let config = ServerConfig::new([client_endpoint.id()]);
    let policy = move |_remote, requested| async move {
        if requested != Target::Default {
            return Err(Response::new(ResponseStatus::Denied));
        }
        TcpStream::connect(target)
            .await
            .map(Destination::tcp)
            .map_err(|err| Response::new(ResponseStatus::Unreachable).with_message(err.to_string()))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::new(client_endpoint.clone(), server_addr);

    let opened = tokio::time::timeout(
        PATIENCE,
        join_all((0..4).map(|_| client.open(Target::Default))),
    )
    .await
    .expect("opening streams timed out")
    .into_iter()
    .map(|result| result.expect("opening a stream"))
    .collect::<Vec<_>>();
    let connection_ids = opened
        .iter()
        .map(|stream| stream.connection().stable_id())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        connection_ids.len(),
        1,
        "concurrent opens must share one connection"
    );

    for (index, mut stream) in opened.into_iter().enumerate() {
        let payload = format!("stream {index}");
        stream.write_all(payload.as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
        let mut echoed = Vec::new();
        stream.read_to_end(&mut echoed).await.unwrap();
        assert_eq!(echoed, payload.as_bytes());
    }

    let rejected = client
        .open(Target::LocalPort(1))
        .await
        .expect_err("policy must reject an unconfigured target");
    assert_eq!(
        rejected.response().map(|response| response.status),
        Some(ResponseStatus::Denied)
    );

    let ping = client
        .ping()
        .await
        .expect("pinging over the shared connection");
    stop.send(()).unwrap();
    match tokio::time::timeout(PATIENCE, ping.connection().closed())
        .await
        .expect("the shutdown close frame never arrived")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_SHUTDOWN)
        }
        other => panic!("expected an application shutdown close, got {other:?}"),
    }
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");

    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn invalid_target_is_rejected_before_dial_or_connection_retirement() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let config = ServerConfig::new([client_endpoint.id()]);
    let policy = |_remote, _target| async {
        std::result::Result::<Destination, Response>::Err(Response::new(ResponseStatus::Denied))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::new(client_endpoint.clone(), server_addr);

    let before = client
        .ping()
        .await
        .expect("establishing a shared connection");
    let error = client
        .open(Target::LocalPort(0))
        .await
        .expect_err("port zero must be rejected locally");
    assert!(matches!(error, ClientError::InvalidTarget(_)));
    let after = client.ping().await.expect("reusing the shared connection");
    assert_eq!(
        before.connection().stable_id(),
        after.connection().stable_id(),
        "a local validation error retired the healthy shared connection"
    );

    drop((before, after));
    stop.send(()).unwrap();
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");
    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn aborting_serve_closes_active_connections_with_shutdown_code() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let config = ServerConfig::new([client_endpoint.id()]);
    let policy = |_remote, _target| async {
        std::result::Result::<Destination, Response>::Err(Response::new(ResponseStatus::Denied))
    };
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(std::future::pending()));
    let client = Client::new(client_endpoint.clone(), server_addr);

    let ping = tokio::time::timeout(PATIENCE, client.ping())
        .await
        .expect("ping timed out")
        .expect("ping failed");
    server_task.abort();
    let join_error = tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("aborted server task did not finish")
        .expect_err("aborted server task unexpectedly succeeded");
    assert!(join_error.is_cancelled());

    match tokio::time::timeout(PATIENCE, ping.connection().closed())
        .await
        .expect("the cancellation close frame never arrived")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_SHUTDOWN)
        }
        other => panic!("expected an application shutdown close, got {other:?}"),
    }

    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn cancelling_server_handler_before_ack_aborts_both_stream_halves() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection")
    });
    let client_connection = client_endpoint
        .connect(iroh_utils::dialable_addr(&server_endpoint), ALPN)
        .await
        .unwrap();
    let server_connection = accepting.await.unwrap();
    let (mut client_send, mut client_recv) = client_connection.open_bi().await.unwrap();
    protocol::write_request(&mut client_send, &Request::Connect(Target::Default))
        .await
        .unwrap();
    let server_streams = server_connection.accept_bi().await.unwrap();

    let entered = Arc::new(tokio::sync::Notify::new());
    let policy_entered = entered.clone();
    let policy = Arc::new(move |_remote, _target| {
        let policy_entered = policy_entered.clone();
        async move {
            policy_entered.notify_one();
            std::future::pending::<std::result::Result<Destination, Response>>().await
        }
    });
    let handler = tokio::spawn(handle_stream(
        server_connection.stable_id(),
        server_connection.remote_id(),
        policy,
        PreAckStreams::new(server_streams),
        PATIENCE,
        PATIENCE,
        None,
    ));
    entered.notified().await;
    handler.abort();
    assert!(handler.await.unwrap_err().is_cancelled());

    match tokio::time::timeout(PATIENCE, client_recv.read_to_end(1024))
        .await
        .expect("the server receive reset stayed pending")
    {
        Err(ReadToEndError::Read(ReadError::Reset(code))) => assert_eq!(code, RESET_ABORTED),
        other => panic!("expected reset {RESET_ABORTED}, got {other:?}"),
    }
    assert_eq!(
        tokio::time::timeout(PATIENCE, client_send.stopped())
            .await
            .expect("the server stop stayed pending")
            .expect("checking the server stop code"),
        Some(RESET_ABORTED)
    );

    client_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    server_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn opened_stream_keeps_client_connection_alive() {
    let target = echo_server().await;
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let config = ServerConfig::new([client_endpoint.id()]);
    let policy = move |_remote, requested| async move {
        if requested != Target::Default {
            return Err(Response::new(ResponseStatus::Denied));
        }
        TcpStream::connect(target)
            .await
            .map(Destination::tcp)
            .map_err(|err| Response::new(ResponseStatus::Unreachable).with_message(err.to_string()))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::new(client_endpoint.clone(), server_addr);
    let mut stream = tokio::time::timeout(PATIENCE, client.open(Target::Default))
        .await
        .expect("opening a stream timed out")
        .expect("opening a stream failed");

    drop(client);
    stream.write_all(b"still alive").await.unwrap();
    stream.shutdown().await.unwrap();
    let mut echoed = Vec::new();
    stream.read_to_end(&mut echoed).await.unwrap();
    assert_eq!(echoed, b"still alive");
    drop(stream);

    stop.send(()).unwrap();
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn dropping_a_cleanly_completed_opened_stream_preserves_fin_and_eof() {
    let (
        client_endpoint,
        server_endpoint,
        client,
        mut opened,
        server_connection,
        mut peer_send,
        mut peer_recv,
    ) = raw_opened_stream().await;

    peer_send.write_all(b"reply").await.unwrap();
    peer_send.shutdown().await.unwrap();
    let mut reply = Vec::new();
    opened.read_to_end(&mut reply).await.unwrap();
    assert_eq!(reply, b"reply");
    assert!(
        opened.recv_done,
        "reading EOF did not mark the receive half done"
    );

    opened.write_all(b"request").await.unwrap();
    opened.shutdown().await.unwrap();
    assert!(
        opened.send_done,
        "shutting down did not mark the send half done"
    );
    drop(opened);

    assert_eq!(
        tokio::time::timeout(PATIENCE, peer_recv.read_to_end(1024))
            .await
            .expect("the clean FIN never reached the peer")
            .expect("dropping a completed OpenedStream reset its send half"),
        b"request"
    );
    assert_eq!(
        tokio::time::timeout(PATIENCE, peer_send.stopped())
            .await
            .expect("the completed receive half stayed pending")
            .expect("checking the completed receive half"),
        None,
        "dropping a completed OpenedStream stopped its receive half"
    );

    client.close().await;
    server_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn dropping_an_unfinished_opened_stream_aborts_both_halves() {
    let (
        client_endpoint,
        server_endpoint,
        client,
        opened,
        server_connection,
        mut peer_send,
        mut peer_recv,
    ) = raw_opened_stream().await;
    drop(opened);

    match tokio::time::timeout(PATIENCE, peer_recv.read_to_end(1024))
        .await
        .expect("the peer receive half stayed pending")
    {
        Err(ReadToEndError::Read(ReadError::Reset(code))) => assert_eq!(code, RESET_ABORTED),
        other => panic!("expected reset {RESET_ABORTED}, got {other:?}"),
    }
    assert_eq!(
        tokio::time::timeout(PATIENCE, peer_send.stopped())
            .await
            .expect("the peer send half stayed pending")
            .expect("checking whether the peer stopped the stream"),
        Some(RESET_ABORTED),
    );

    client.close().await;
    server_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn dropping_unpolled_opened_splice_aborts_before_client_keepalive() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        let connection = accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection");
        let (mut send, mut recv) = connection
            .accept_bi()
            .await
            .expect("accepting the test stream");
        assert_eq!(
            protocol::read_request(&mut recv).await.unwrap(),
            Request::Connect(Target::Default)
        );
        protocol::write_response(&mut send, &Response::ok())
            .await
            .unwrap();
        (connection, send, recv)
    });
    let client = Client::new(client_endpoint.clone(), server_addr);
    let opened = client
        .open(Target::Default)
        .await
        .expect("opening the test stream");
    let (server_connection, mut peer_send, mut peer_recv) =
        accepting.await.expect("accept task panicked");

    let splice = opened.splice(tokio::io::empty(), tokio::io::sink(), LocalEof::HalfClose);
    drop(splice);

    match tokio::time::timeout(PATIENCE, peer_recv.read_to_end(1024))
        .await
        .expect("the peer receive half stayed pending")
    {
        Err(ReadToEndError::Read(ReadError::Reset(code))) => {
            assert_eq!(code, RESET_ABORTED)
        }
        other => panic!("expected reset {RESET_ABORTED}, got {other:?}"),
    }
    assert_eq!(
        tokio::time::timeout(PATIENCE, peer_send.stopped())
            .await
            .expect("the peer send half stayed pending")
            .expect("checking whether the peer stopped the stream"),
        Some(RESET_ABORTED),
    );

    drop(client);
    server_connection.close(iroh_utils::CLOSE_DONE, b"test done");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn ping_keeps_temporary_client_alive_for_path_inspection() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let config = ServerConfig::new([client_endpoint.id()]);
    let policy = |_remote, _target| async {
        std::result::Result::<Destination, Response>::Err(Response::new(ResponseStatus::Denied))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));

    let client = Client::new(client_endpoint.clone(), server_addr);
    let ping = client.ping().await.expect("ping failed");
    drop(client);
    assert!(
        ping.connection().close_reason().is_none(),
        "dropping the source Client closed the Ping's inspection connection"
    );

    stop.send(()).unwrap();
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");
    drop(ping);
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn shutdown_closes_retired_connections_with_open_streams() {
    let target = echo_server().await;
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let mut server_config = ServerConfig::new([client_endpoint.id()]);
    server_config.target_timeout = PATIENCE;
    let policy = move |_remote, requested| async move {
        if requested == Target::Default {
            return TcpStream::connect(target)
                .await
                .map(Destination::tcp)
                .map_err(|err| {
                    Response::new(ResponseStatus::Unreachable).with_message(err.to_string())
                });
        }
        tokio::time::sleep(PATIENCE).await;
        Err(Response::new(ResponseStatus::Denied))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), server_config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::with_config(
        client_endpoint.clone(),
        server_addr,
        ClientConfig {
            dial_timeout: PATIENCE,
            request_timeout: Duration::from_millis(100),
        },
    );

    let older = tokio::time::timeout(PATIENCE, client.open(Target::Default))
        .await
        .expect("opening the older stream timed out")
        .expect("opening the older stream failed");
    let error = client
        .open(Target::LocalPort(1))
        .await
        .expect_err("the deliberately blackholed request succeeded");
    assert!(matches!(error, ClientError::RequestTimeout(_)));
    assert!(
        client.0.state.lock().await.current.is_none(),
        "the replacement's retryable failure remained cached"
    );
    let newer = client
        .ping()
        .await
        .expect("pinging the replacement connection");
    assert_ne!(
        older.connection().stable_id(),
        newer.connection().stable_id(),
        "the pre-ack retry did not install a replacement connection"
    );

    client.shutdown().await;
    for connection in [older.connection(), newer.connection()] {
        match tokio::time::timeout(PATIENCE, connection.closed())
            .await
            .expect("a tracked connection did not receive a close frame")
        {
            ConnectionError::LocallyClosed => {}
            other => panic!("expected a local shutdown close, got {other:?}"),
        }
    }

    drop((older, newer));
    stop.send(()).unwrap();
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn retired_connection_closes_after_its_last_managed_user() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let accepting_endpoint = server_endpoint.clone();
    let accepting = tokio::spawn(async move {
        accepting_endpoint
            .accept()
            .await
            .expect("the server endpoint stayed open")
            .await
            .expect("accepting the test connection")
    });
    let connection = client_endpoint
        .connect(iroh_utils::dialable_addr(&server_endpoint), ALPN)
        .await
        .expect("connecting the test client");
    let peer = accepting.await.expect("accept task panicked");

    let managed = Arc::new(ManagedConnection::new(connection));
    let active_user = managed.clone();
    managed.retire();
    drop(managed);
    tokio::task::yield_now().await;
    assert!(
        peer.close_reason().is_none(),
        "retirement interrupted an existing managed user"
    );

    drop(active_user);
    match tokio::time::timeout(PATIENCE, peer.closed())
        .await
        .expect("retiring the last managed user did not close the connection")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_RETIRED)
        }
        other => panic!("expected the retirement close, got {other:?}"),
    }

    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn sink_delays_eof_until_all_input_is_delivered_and_shutdown() {
    let (local, mut captured) = tokio::io::duplex(1024);
    let mut destination = Destination::sink(local);
    let (mut eof, mut write, local_eof) = destination.take_parts();
    assert_eq!(local_eof, LocalEof::HalfClose);

    let mut byte = [0_u8; 1];
    assert!(
        tokio::time::timeout(Duration::from_millis(20), eof.read(&mut byte))
            .await
            .is_err(),
        "the sink reported EOF before its writer shut down"
    );

    write.write_all(b"complete payload").await.unwrap();
    write.shutdown().await.unwrap();
    assert_eq!(eof.read(&mut byte).await.unwrap(), 0);
    let mut payload = Vec::new();
    captured.read_to_end(&mut payload).await.unwrap();
    assert_eq!(payload, b"complete payload");
}

#[tokio::test]
async fn split_destination_and_one_shot_server_finish_cleanly() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let mut config = ServerConfig::new([client_endpoint.id()]);
    config.exit_after_first_stream = true;
    let policy = |_remote, requested| async move {
        if requested != Target::Default {
            return Err(Response::new(ResponseStatus::Denied));
        }
        let (destination, echo) = tokio::io::duplex(1024);
        let (read, write) = tokio::io::split(destination);
        let (mut echo_read, mut echo_write) = tokio::io::split(echo);
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut echo_read, &mut echo_write).await;
        });
        Ok(Destination::split(read, write, LocalEof::HalfClose))
    };
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(std::future::pending()));
    let client = Client::new(client_endpoint.clone(), server_addr);

    let ping = client.ping().await.expect("pinging the one-shot server");
    drop(ping);
    assert!(
        !server_task.is_finished(),
        "a ping consumed the one-shot destination"
    );
    let denied = client
        .open(Target::LocalPort(1))
        .await
        .expect_err("a non-default one-shot target was accepted");
    assert_eq!(
        denied.response().map(|response| response.status),
        Some(ResponseStatus::Denied)
    );
    assert!(
        !server_task.is_finished(),
        "a denied request consumed the one-shot destination"
    );

    let mut opened = client.open(Target::Default).await.unwrap();
    opened
        .write_all(b"through split destination")
        .await
        .unwrap();
    opened.shutdown().await.unwrap();
    let mut echoed = Vec::new();
    opened.read_to_end(&mut echoed).await.unwrap();
    assert_eq!(echoed, b"through split destination");
    drop(opened);

    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("one-shot server did not exit after its committed stream")
        .expect("server task panicked")
        .expect("server failed");
    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn shutdown_interrupts_one_shot_connection_drain() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let mut config = ServerConfig::new([client_endpoint.id()]);
    config.exit_after_first_stream = true;
    let policy = |_remote, _target| async {
        std::result::Result::<Destination, Response>::Err(Response::new(ResponseStatus::Denied))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::new(client_endpoint.clone(), server_addr);
    let ping = client
        .ping()
        .await
        .expect("establishing one-shot connection");

    stop.send(()).unwrap();
    match tokio::time::timeout(PATIENCE, ping.connection().closed())
        .await
        .expect("one-shot shutdown close did not reach the client")
    {
        ConnectionError::ApplicationClosed(close) => {
            assert_eq!(close.error_code, CLOSE_SHUTDOWN)
        }
        other => panic!("expected shutdown close, got {other:?}"),
    }
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("interrupted one-shot server did not exit")
        .expect("server task panicked")
        .expect("server failed");

    drop(ping);
    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}

#[tokio::test]
async fn zero_per_connection_stream_limit_refuses_streams() {
    let client_endpoint = iroh_boring::builder().bind().await.unwrap();
    let server_endpoint = iroh_boring::builder()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap();
    let server_addr = iroh_utils::dialable_addr(&server_endpoint);
    let mut config = ServerConfig::new([client_endpoint.id()]);
    config.max_streams_per_connection = 0;
    let policy = |_remote, _target| async {
        std::result::Result::<Destination, Response>::Err(Response::new(ResponseStatus::Denied))
    };
    let (stop, stopped) = oneshot::channel();
    let server = Server::new(server_endpoint.clone(), config, policy);
    let server_task = tokio::spawn(server.serve(async move {
        let _ = stopped.await;
    }));
    let client = Client::new(client_endpoint.clone(), server_addr);

    let error = tokio::time::timeout(PATIENCE, client.ping())
        .await
        .expect("ping timed out")
        .expect_err("a zero stream limit accepted a request");
    assert_eq!(
        error.response().map(|response| response.status),
        Some(ResponseStatus::Busy)
    );

    stop.send(()).unwrap();
    tokio::time::timeout(PATIENCE, server_task)
        .await
        .expect("the server did not stop")
        .expect("the server task panicked")
        .expect("the server failed");
    client.close().await;
    client_endpoint.close().await;
    server_endpoint.close().await;
}
