// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn server_id() -> String {
    iroh::SecretKey::generate().public().to_string()
}

#[test]
fn socks_disambiguates_optional_server_and_delimited_child_command() {
    let cli = Cli::try_parse_from(["burrow", "socks"]).unwrap();
    let Command::Socks {
        server, command, ..
    } = cli.command
    else {
        panic!("parsed the wrong command")
    };
    assert!(server.is_none());
    assert!(command.is_empty());

    let cli = Cli::try_parse_from([
        "burrow",
        "socks",
        "--",
        "curl",
        "--fail",
        "http://br1-token:80/",
    ])
    .unwrap();
    let Command::Socks {
        server, command, ..
    } = cli.command
    else {
        panic!("parsed the wrong command")
    };
    assert!(server.is_none());
    assert_eq!(command, ["curl", "--fail", "http://br1-token:80/"]);

    let server = server_id();
    let cli = Cli::try_parse_from(["burrow", "socks", &server]).unwrap();
    let Command::Socks {
        server: parsed_server,
        command,
        ..
    } = cli.command
    else {
        panic!("parsed the wrong command")
    };
    assert!(parsed_server.is_some());
    assert!(command.is_empty());

    let cli = Cli::try_parse_from([
        "burrow",
        "socks",
        &server,
        "--",
        "curl",
        "https://example.com/",
    ])
    .unwrap();
    let Command::Socks {
        server, command, ..
    } = cli.command
    else {
        panic!("parsed the wrong command")
    };
    assert!(server.is_some());
    assert_eq!(command, ["curl", "https://example.com/"]);
}

#[test]
fn socks_direct_hints_require_a_fixed_server() {
    let error = match Cli::try_parse_from(["burrow", "socks", "--addr", "127.0.0.1:4242"]) {
        Ok(_) => panic!("--addr without SERVER was accepted"),
        Err(error) => error,
    };
    assert!(error.to_string().to_ascii_lowercase().contains("server"));
}
