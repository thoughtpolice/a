// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Where outputs go, as named by `-o`.

use anyhow::{Context, Result, bail};
use std::fmt;
use std::io::{self, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{fs, thread};

/// The largest UDP payload over IPv4.
const MAX_DATAGRAM: usize = 65_507;

/// How long to wait between attempts to reach a TCP server.
const RETRY_DELAY: Duration = Duration::from_millis(100);

/// How many failed attempts to reach a TCP server pass between notes on
/// standard error: about ten seconds' worth.
const RETRY_NOTE: u64 = 100;

/// The suffix `%s` gives when the sample has no path or no suffix.
const DEFAULT_SUFFIX: &str = "rad";

pub enum Output {
    Stdout,
    Files(PathPattern),
    /// Serves each output to the next client that connects.
    TcpServer(TcpListener),
    /// Connects to a server for each output, waiting until it listens.
    TcpClient(SocketAddr),
    Udp(UdpSocket, SocketAddr),
}

/// What a path pattern may need to know about one output.
pub struct Name<'a> {
    pub nth: u64,
    pub checksum: &'a str,
    pub source: Option<&'a Path>,
}

/// Where one output went.
pub enum Destination {
    Stdout,
    File(PathBuf),
    TcpServer(SocketAddr),
    TcpClient(SocketAddr),
    Udp(SocketAddr),
}

impl Destination {
    /// The `output` field of the output's metadata record.
    pub fn kind(&self) -> &'static str {
        match self {
            Destination::Stdout => "stdout",
            Destination::File(_) => "file",
            Destination::TcpServer(_) => "tcp-server",
            Destination::TcpClient(_) => "tcp-client",
            Destination::Udp(_) => "udp-client",
        }
    }
}

impl Output {
    /// Parses `-o`: `-` for standard output, `:PORT` for a TCP server,
    /// `ADDRESS:PORT` with an optional `/tcp` or `/udp` for a client, and
    /// otherwise a path pattern. `first_suffix` is what `%p` stands for.
    pub fn parse(spec: &str, first_suffix: &str) -> Result<Self> {
        if spec == "-" {
            return Ok(Output::Stdout);
        }
        let (address, udp) = match spec.rsplit_once('/') {
            Some((address, "tcp")) => (address, false),
            Some((address, "udp")) => (address, true),
            _ => (spec, false),
        };
        if let Some(port) = address.strip_prefix(':')
            && let Ok(port) = port.parse::<u16>()
        {
            if udp {
                bail!("kermit cannot serve outputs over UDP, only send them to an address");
            }
            let listener = TcpListener::bind(("0.0.0.0", port))
                .with_context(|| format!("cannot listen on port {port}"))?;
            return Ok(Output::TcpServer(listener));
        }
        if let Ok(address) = address.parse::<SocketAddr>() {
            if !udp {
                return Ok(Output::TcpClient(address));
            }
            let local = if address.is_ipv4() {
                "0.0.0.0:0"
            } else {
                "[::]:0"
            };
            let socket = UdpSocket::bind(local).context("cannot open a UDP socket")?;
            return Ok(Output::Udp(socket, address));
        }
        Ok(Output::Files(PathPattern::parse(spec, first_suffix)?))
    }

    /// Whether each output gets a place of its own, so that writing many
    /// does not overwrite one file.
    pub fn names_each_output(&self) -> bool {
        match self {
            Output::Files(pattern) => pattern.distinct(),
            _ => true,
        }
    }

    /// Writes `data` and says where it went and how many bytes arrived. A
    /// peer that hangs up early cuts the write short without an error,
    /// since a target that crashes on its input does just that.
    pub fn write(&mut self, data: &[u8], name: &Name) -> Result<(Destination, usize)> {
        match self {
            Output::Stdout => {
                let mut stdout = io::stdout().lock();
                stdout.write_all(data)?;
                stdout.flush()?;
                Ok((Destination::Stdout, data.len()))
            }
            Output::Files(pattern) => {
                let path = PathBuf::from(pattern.render(name));
                fs::write(&path, data)
                    .with_context(|| format!("cannot write to {}", path.display()))?;
                Ok((Destination::File(path), data.len()))
            }
            Output::TcpServer(listener) => {
                let (mut stream, peer) = listener.accept().context("cannot accept a client")?;
                Ok((Destination::TcpServer(peer), send(&mut stream, data)))
            }
            Output::TcpClient(address) => {
                let mut stream = connect(*address);
                Ok((Destination::TcpClient(*address), send(&mut stream, data)))
            }
            Output::Udp(socket, address) => {
                if data.len() > MAX_DATAGRAM {
                    eprintln!(
                        "kermit: output {} has {} bytes, too many for one datagram, so it was not sent",
                        name.nth,
                        data.len()
                    );
                    return Ok((Destination::Udp(*address), 0));
                }
                let sent = socket
                    .send_to(data, *address)
                    .with_context(|| format!("cannot send to {address}"))?;
                Ok((Destination::Udp(*address), sent))
            }
        }
    }
}

fn connect(address: SocketAddr) -> TcpStream {
    let mut attempts = 0_u64;
    loop {
        match TcpStream::connect(address) {
            Ok(stream) => return stream,
            Err(error) => {
                attempts += 1;
                if attempts.is_multiple_of(RETRY_NOTE) {
                    eprintln!(
                        "kermit: still cannot connect to {address} after {attempts} attempts: {error}"
                    );
                }
                thread::sleep(RETRY_DELAY);
            }
        }
    }
}

/// Writes as much of `data` as the peer takes.
fn send(stream: &mut TcpStream, data: &[u8]) -> usize {
    let mut sent = 0;
    while sent < data.len() {
        match stream.write(&data[sent..]) {
            Ok(0) => break,
            Ok(count) => sent += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    sent
}

/// An output path with `%` escapes.
#[derive(Debug, PartialEq, Eq)]
pub struct PathPattern(Vec<Part>);

#[derive(Debug, PartialEq, Eq)]
enum Part {
    Text(String),
    /// The output's number, padded with zeros to `width` digits.
    Number {
        width: usize,
    },
    Suffix,
    Checksum,
}

impl PathPattern {
    /// Parses `%n` for the output's number, `%0Nn` for the number padded
    /// to N digits, `%s` for the sample's suffix, `%p` for the first sample
    /// path's suffix, `%h` for the output's checksum and `%%` for `%`.
    pub fn parse(pattern: &str, first_suffix: &str) -> Result<Self> {
        let mut parts = Vec::new();
        let mut text = String::new();
        let mut chars = pattern.chars();
        while let Some(char) = chars.next() {
            if char != '%' {
                text.push(char);
                continue;
            }
            let part = match chars.next() {
                Some('%') => {
                    text.push('%');
                    continue;
                }
                Some('p') => {
                    text.push_str(first_suffix);
                    continue;
                }
                Some('n') => Part::Number { width: 0 },
                Some('0') => {
                    let rest = chars.as_str();
                    let digits =
                        rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
                    let width = rest[..digits].parse().unwrap_or(0);
                    chars = rest[digits..].chars();
                    if chars.next() != Some('n') {
                        bail!(
                            "output path {pattern:?} pads something other than %n. Write %0Nn, as in %04n"
                        );
                    }
                    Part::Number { width }
                }
                Some('s') => Part::Suffix,
                Some('h') => Part::Checksum,
                other => bail!(
                    "output path {pattern:?} has the unknown escape %{}. Use %n, %0Nn, %s, %p, %h or %%",
                    other.map(String::from).unwrap_or_default()
                ),
            };
            parts.push(Part::Text(std::mem::take(&mut text)));
            parts.push(part);
        }
        parts.push(Part::Text(text));
        parts.retain(|part| !matches!(part, Part::Text(text) if text.is_empty()));
        Ok(Self(parts))
    }

    fn distinct(&self) -> bool {
        self.0
            .iter()
            .any(|part| matches!(part, Part::Number { .. } | Part::Checksum))
    }

    fn render(&self, name: &Name) -> String {
        let mut out = String::new();
        for part in &self.0 {
            match part {
                Part::Text(text) => out.push_str(text),
                Part::Number { width } => out.push_str(&format!("{:0width$}", name.nth)),
                Part::Suffix => {
                    out.push_str(name.source.and_then(suffix).unwrap_or(DEFAULT_SUFFIX))
                }
                Part::Checksum => out.push_str(name.checksum),
            }
        }
        out
    }
}

/// The text after the last dot of a path's file name, if any.
pub fn suffix(path: &Path) -> Option<&str> {
    path.extension()
        .and_then(|suffix| suffix.to_str())
        .filter(|suffix| !suffix.is_empty())
}

impl fmt::Display for Destination {
    /// How `--verbose` names a destination.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Destination::Stdout => formatter.write_str("stdout"),
            Destination::File(path) => write!(formatter, "{}", path.display()),
            Destination::TcpServer(peer) => write!(formatter, "client {peer}"),
            Destination::TcpClient(address) | Destination::Udp(address) => {
                write!(formatter, "{address}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(pattern: &str, nth: u64, source: Option<&str>) -> String {
        let name = Name {
            nth,
            checksum: "c0ffee",
            source: source.map(Path::new),
        };
        PathPattern::parse(pattern, "txt").unwrap().render(&name)
    }

    #[test]
    fn renders_path_patterns() {
        assert_eq!(
            render("/tmp/fuzz-%n.%s", 7, Some("a/b.png")),
            "/tmp/fuzz-7.png"
        );
        assert_eq!(render("out-%04n", 12, None), "out-0012");
        assert_eq!(render("out-%0n", 12, None), "out-12");
        assert_eq!(render("%h.%s", 1, Some("noext")), "c0ffee.rad");
        assert_eq!(render("all.%p", 1, None), "all.txt");
        assert_eq!(render("100%%-%n", 3, None), "100%-3");
    }

    #[test]
    fn rejects_unknown_escapes() {
        for (pattern, error) in [
            (
                "a%x",
                "output path \"a%x\" has the unknown escape %x. Use %n, %0Nn, %s, %p, %h or %%",
            ),
            (
                "a%",
                "output path \"a%\" has the unknown escape %. Use %n, %0Nn, %s, %p, %h or %%",
            ),
            (
                "a%04d",
                "output path \"a%04d\" pads something other than %n. Write %0Nn, as in %04n",
            ),
        ] {
            assert_eq!(
                PathPattern::parse(pattern, "").unwrap_err().to_string(),
                error
            );
        }
    }

    #[test]
    fn knows_when_outputs_share_a_path() {
        let distinct = |pattern| PathPattern::parse(pattern, "").unwrap().distinct();
        assert!(distinct("out-%n"));
        assert!(distinct("out-%03n"));
        assert!(distinct("out-%h"));
        assert!(!distinct("out.%s"));
        assert!(!distinct("100%%n"));
    }

    #[test]
    fn parses_network_outputs() {
        assert!(matches!(Output::parse("-", "").unwrap(), Output::Stdout));
        assert!(matches!(
            Output::parse("127.0.0.1:80", "").unwrap(),
            Output::TcpClient(address) if address.port() == 80
        ));
        assert!(matches!(
            Output::parse("[::1]:80/tcp", "").unwrap(),
            Output::TcpClient(address) if address.is_ipv6()
        ));
        assert!(matches!(
            Output::parse("127.0.0.1:53/udp", "").unwrap(),
            Output::Udp(_, address) if address.port() == 53
        ));
        assert!(matches!(
            Output::parse(":0", "").unwrap(),
            Output::TcpServer(_)
        ));
        assert!(Output::parse(":53/udp", "").is_err());
        assert!(matches!(
            Output::parse("host:80", "").unwrap(),
            Output::Files(_)
        ));
    }
}
