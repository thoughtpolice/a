// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn name(text: &str) -> HostName {
    HostName::new(text).unwrap()
}

async fn request_round_trip(request: Request) {
    let (mut writer, mut reader) = tokio::io::duplex(1024);
    write_request(&mut writer, &request).await.unwrap();
    assert_eq!(read_request(&mut reader).await.unwrap(), request);
}

async fn response_round_trip(response: Response) {
    let (mut writer, mut reader) = tokio::io::duplex(8192);
    write_response(&mut writer, &response).await.unwrap();
    assert_eq!(read_response(&mut reader).await.unwrap(), response);
}

async fn read_raw_request(bytes: &[u8]) -> io::Result<Request> {
    let (mut writer, mut reader) = tokio::io::duplex(bytes.len().max(1));
    writer.write_all(bytes).await.unwrap();
    drop(writer);
    read_request(&mut reader).await
}

async fn read_raw_response(bytes: &[u8]) -> io::Result<Response> {
    let (mut writer, mut reader) = tokio::io::duplex(bytes.len().max(1));
    writer.write_all(bytes).await.unwrap();
    drop(writer);
    read_response(&mut reader).await
}

#[tokio::test]
async fn every_request_shape_round_trips() {
    let requests = [
        Request::Ping,
        Request::Connect(Target::Default),
        Request::Connect(Target::LocalPort(22)),
        Request::Connect(Target::Tcp {
            host: Host::Ip("192.0.2.10".parse().unwrap()),
            port: 443,
        }),
        Request::Connect(Target::Tcp {
            host: Host::Ip("2001:db8::10".parse().unwrap()),
            port: 8443,
        }),
        Request::Connect(Target::Tcp {
            host: Host::Name(name("host.internal.example")),
            port: 8080,
        }),
    ];
    for request in requests {
        request_round_trip(request).await;
    }
}

#[tokio::test]
async fn request_reader_leaves_stream_payload_unread() {
    let request = Request::Connect(Target::Default);
    let (mut writer, mut reader) = tokio::io::duplex(1024);
    write_request(&mut writer, &request).await.unwrap();
    writer.write_all(b"ssh payload").await.unwrap();
    assert_eq!(read_request(&mut reader).await.unwrap(), request);
    let mut payload = [0; 11];
    reader.read_exact(&mut payload).await.unwrap();
    assert_eq!(&payload, b"ssh payload");
}

#[tokio::test]
async fn every_response_status_round_trips() {
    for status in [
        ResponseStatus::Ok,
        ResponseStatus::Denied,
        ResponseStatus::Unreachable,
        ResponseStatus::Busy,
        ResponseStatus::BadRequest,
    ] {
        response_round_trip(Response::new(status).with_message("details")).await;
    }
}

#[tokio::test]
async fn rejects_bad_request_magic_kinds_and_truncation() {
    assert_eq!(
        read_raw_request(b"BRW2\0").await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_raw_request(b"BRW1\xff").await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_raw_request(b"BRW1\x01\xff").await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_raw_request(b"BRW1\x01\x02\xff")
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_raw_request(b"BRW1\x01\x01\0")
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::UnexpectedEof
    );

    assert_eq!(
        read_raw_request(b"BRW1\x01\x01\0\0")
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );

    for target in [
        Target::LocalPort(0),
        Target::Tcp {
            host: Host::Ip(Ipv4Addr::LOCALHOST.into()),
            port: 0,
        },
    ] {
        assert!(target.validate().is_err());
        let (mut writer, _) = tokio::io::duplex(64);
        assert_eq!(
            write_request(&mut writer, &Request::Connect(target))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}

#[tokio::test]
async fn rejects_invalid_or_oversized_hostnames() {
    let oversized = (MAX_HOST_BYTES as u16 + 1).to_be_bytes();
    let mut frame = b"BRW1\x01\x02\x02".to_vec();
    frame.extend_from_slice(&oversized);
    assert_eq!(
        read_raw_request(&frame).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    let invalid_utf8 = b"BRW1\x01\x02\x02\0\x01\xff\0\x50";
    assert_eq!(
        read_raw_request(invalid_utf8).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    let empty = b"BRW1\x01\x02\x02\0\0\0\x50";
    assert_eq!(
        read_raw_request(empty).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    assert!(HostName::new(&"x".repeat(MAX_HOST_BYTES + 1)).is_err());
    assert!(HostName::new("line\nbreak").is_err());
    assert!(HostName::new("right\u{202e}left").is_err());

    // The writer retains a defensive validation boundary even though an
    // external caller cannot construct this invalid private representation.
    let too_long = Request::Connect(Target::Tcp {
        host: Host::Name(HostName("x".repeat(MAX_HOST_BYTES + 1))),
        port: 80,
    });
    let (mut writer, _) = tokio::io::duplex(1024);
    assert_eq!(
        write_request(&mut writer, &too_long)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

#[tokio::test]
async fn rejects_bad_response_magic_status_length_and_utf8() {
    assert_eq!(
        read_raw_response(b"BRS2\0\0\0").await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        read_raw_response(b"BRS1\xff\0\0").await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    let mut oversized = b"BRS1\0".to_vec();
    oversized.extend_from_slice(&(MAX_RESPONSE_BYTES as u16 + 1).to_be_bytes());
    assert_eq!(
        read_raw_response(&oversized).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );

    assert_eq!(
        read_raw_response(b"BRS1\0\0\x01\xff")
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );

    assert_eq!(
        read_raw_response(b"BRS1\0\0\x04bad\n")
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );

    let safe = Response::new(ResponseStatus::Denied).with_message("line\n\x1b[31m");
    assert_eq!(safe.message(), r"line\n\u{1b}[31m");

    let bounded =
        Response::new(ResponseStatus::Denied).with_message("x".repeat(MAX_RESPONSE_BYTES + 1));
    assert_eq!(bounded.message().len(), MAX_RESPONSE_BYTES);
    assert!(bounded.message().ends_with('…'));
    response_round_trip(bounded).await;

    let exactly_bounded =
        Response::new(ResponseStatus::Denied).with_message("x".repeat(MAX_RESPONSE_BYTES));
    assert_eq!(exactly_bounded.message(), "x".repeat(MAX_RESPONSE_BYTES));

    // As with HostName, keep the encoder defensive against an invalid
    // representation constructed inside this module.
    let too_long = Response {
        status: ResponseStatus::Denied,
        message: "x".repeat(MAX_RESPONSE_BYTES + 1),
    };
    let (mut writer, _) = tokio::io::duplex(8192);
    assert_eq!(
        write_response(&mut writer, &too_long)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn target_parser_accepts_every_cli_form() {
    assert_eq!("default".parse::<Target>().unwrap(), Target::Default);
    assert_eq!("22".parse::<Target>().unwrap(), Target::LocalPort(22));
    assert_eq!(
        "192.0.2.1:443".parse::<Target>().unwrap(),
        Target::Tcp {
            host: Host::Ip("192.0.2.1".parse().unwrap()),
            port: 443,
        }
    );
    assert_eq!(
        "[2001:db8::1]:8443".parse::<Target>().unwrap(),
        Target::Tcp {
            host: Host::Ip("2001:db8::1".parse().unwrap()),
            port: 8443,
        }
    );
    assert_eq!(
        "service.internal:8080".parse::<Target>().unwrap(),
        Target::Tcp {
            host: Host::Name(name("service.internal")),
            port: 8080,
        }
    );
}

#[test]
fn target_parser_rejects_malformed_forms() {
    for text in [
        "",
        "missing-port",
        ":80",
        "host:nope",
        "70000",
        "0",
        "host:0",
        "127.0.0.1:0",
    ] {
        assert!(text.parse::<Target>().is_err(), "accepted {text:?}");
    }

    let oversized = "x".repeat(MAX_TARGET_BYTES + 1);
    let error = oversized.parse::<Target>().unwrap_err().to_string();
    assert!(error.len() < 100, "error echoed the oversized target");
}

#[test]
fn target_display_is_parseable() {
    for target in [
        Target::Default,
        Target::LocalPort(22),
        Target::Tcp {
            host: Host::Ip("2001:db8::1".parse().unwrap()),
            port: 443,
        },
        Target::Tcp {
            host: Host::Name(name("service.internal")),
            port: 8080,
        },
    ] {
        assert_eq!(target.to_string().parse::<Target>().unwrap(), target);
    }
}
