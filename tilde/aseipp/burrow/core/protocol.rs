// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Control protocol at the start of every Burrow QUIC stream.
//!
//! A request chooses what the server should connect to.  The server answers
//! before either side begins copying opaque stream bytes.  Both frames carry a
//! magic string with the protocol version, and every variable-sized field is
//! bounded before allocation.

use std::error::Error;
use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The iroh ALPN for the first version of the routed Burrow protocol.
pub const ALPN: &[u8] = b"depot/burrow/1";

/// Maximum UTF-8 byte length of a hostname in a connect request.
pub const MAX_HOST_BYTES: usize = 253;

/// Maximum byte length of a textual [`Target`].
///
/// This covers the longest hostname, a separator, and a five-digit TCP port.
pub const MAX_TARGET_BYTES: usize = MAX_HOST_BYTES + 1 + 5;

/// Maximum UTF-8 byte length of a response's diagnostic message.
pub const MAX_RESPONSE_BYTES: usize = 4096;

const REQUEST_MAGIC: [u8; 4] = *b"BRW1";
const RESPONSE_MAGIC: [u8; 4] = *b"BRS1";

const REQUEST_PING: u8 = 0;
const REQUEST_CONNECT: u8 = 1;

const TARGET_DEFAULT: u8 = 0;
const TARGET_LOCAL_PORT: u8 = 1;
const TARGET_TCP: u8 = 2;

const HOST_IPV4: u8 = 0;
const HOST_IPV6: u8 = 1;
const HOST_NAME: u8 = 2;

/// A request made on a newly opened Burrow stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// Ask the server to open a byte stream to a configured target.
    Connect(Target),
    /// Test protocol-level reachability without opening a target connection.
    Ping,
}

/// A destination selected by a client and authorized by the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// The server's configured default target.
    Default,
    /// A TCP port on the server's loopback interface.
    LocalPort(u16),
    /// An arbitrary TCP destination, for an explicitly enabled exit route.
    Tcp { host: Host, port: u16 },
}

impl Target {
    /// Checks that this programmatically constructed target can be encoded.
    ///
    /// Text parsing already enforces these invariants, but the public enum can
    /// also be constructed directly.  Clients use this check before dialing so
    /// a local input error cannot retire an otherwise healthy connection.
    pub fn validate(&self) -> Result<(), ParseTargetError> {
        let port = match self {
            Self::Default => return Ok(()),
            Self::LocalPort(port) | Self::Tcp { port, .. } => *port,
        };
        if port == 0 {
            return Err(ParseTargetError("TCP port 0 is not a destination".into()));
        }
        if let Self::Tcp {
            host: Host::Name(name),
            ..
        } = self
        {
            // HostName's representation is private, but retain this defensive
            // boundary for values constructed inside this module.
            validate_host_name(name.as_str()).map_err(|err| ParseTargetError(err.to_string()))?;
        }
        Ok(())
    }
}

/// The host portion of an arbitrary TCP destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Host {
    /// An IP literal, which requires no name resolution.
    Ip(IpAddr),
    /// A name to resolve at the serving endpoint.
    Name(HostName),
}

/// A validated, bounded DNS-style host name.
///
/// Resolution semantics remain those of the serving operating system.  This
/// type enforces the protocol's framing and terminal-safety invariants; it does
/// not require every label to exist in DNS.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostName(String);

impl HostName {
    /// Validates and copies a borrowed host name.
    pub fn new(name: &str) -> Result<Self, ParseHostNameError> {
        validate_host_name(name)?;
        Ok(Self(name.to_owned()))
    }

    /// Validates an owned host name without copying it.
    pub fn from_string(name: String) -> Result<Self, ParseHostNameError> {
        validate_host_name(&name)?;
        Ok(Self(name))
    }

    /// Returns the validated host name.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consumes the wrapper and returns its string.
    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for HostName {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for HostName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for HostName {
    type Err = ParseHostNameError;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        Self::new(name)
    }
}

impl TryFrom<String> for HostName {
    type Error = ParseHostNameError;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        Self::from_string(name)
    }
}

/// Error returned when a host name violates Burrow's wire invariants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseHostNameError(String);

impl fmt::Display for ParseHostNameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for ParseHostNameError {}

/// The outcome of a request, sent before any opaque stream bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResponseStatus {
    /// The request was accepted; raw stream data follows.
    Ok,
    /// Policy does not allow the client or target.
    Denied,
    /// The server could not connect to the selected target.
    Unreachable,
    /// A resource limit is full; a later attempt may work.
    Busy,
    /// The request is invalid or unsupported.
    BadRequest,
}

/// A server response and its optional human-readable diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    /// Machine-readable result of the request.
    pub status: ResponseStatus,
    /// A bounded UTF-8 explanation, empty when none is needed.
    message: String,
}

impl Response {
    /// Creates a response with an empty diagnostic message.
    pub fn new(status: ResponseStatus) -> Self {
        Self {
            status,
            message: String::new(),
        }
    }

    /// Creates a successful response.
    pub fn ok() -> Self {
        Self::new(ResponseStatus::Ok)
    }

    /// Attaches a bounded, terminal-safe diagnostic message.
    ///
    /// Messages longer than [`MAX_RESPONSE_BYTES`] are truncated on a UTF-8
    /// boundary.  Control and terminal-direction characters are rendered as
    /// visible Rust escapes, so displaying a remote error cannot operate the
    /// caller's terminal.
    pub fn with_message(mut self, message: impl AsRef<str>) -> Self {
        self.message = sanitize_diagnostic(message.as_ref());
        self
    }

    /// Returns the bounded diagnostic message.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Reports whether the request was accepted.
    pub fn is_ok(&self) -> bool {
        self.status == ResponseStatus::Ok
    }
}

impl ResponseStatus {
    fn code(self) -> u8 {
        match self {
            Self::Ok => 0,
            Self::Denied => 1,
            Self::Unreachable => 2,
            Self::Busy => 3,
            Self::BadRequest => 4,
        }
    }

    fn from_code(code: u8) -> io::Result<Self> {
        match code {
            0 => Ok(Self::Ok),
            1 => Ok(Self::Denied),
            2 => Ok(Self::Unreachable),
            3 => Ok(Self::Busy),
            4 => Ok(Self::BadRequest),
            _ => Err(invalid_data(format!("unknown response status {code}"))),
        }
    }
}

/// Writes one complete request frame.
///
/// The function validates variable-sized fields before writing anything, so an
/// invalid local value cannot leave a partial request on the stream.
pub async fn write_request<W>(writer: &mut W, request: &Request) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let frame = encode_request(request)?;
    writer.write_all(&frame).await
}

/// Reads one complete request frame, leaving subsequent stream payload unread.
pub async fn read_request<R>(reader: &mut R) -> io::Result<Request>
where
    R: AsyncRead + Unpin,
{
    read_magic(reader, REQUEST_MAGIC, "request").await?;
    match read_u8(reader).await? {
        REQUEST_PING => Ok(Request::Ping),
        REQUEST_CONNECT => Ok(Request::Connect(read_target(reader).await?)),
        kind => Err(invalid_data(format!("unknown request kind {kind}"))),
    }
}

/// Writes one complete response frame.
///
/// The message is checked against [`MAX_RESPONSE_BYTES`] before anything is
/// written.
pub async fn write_response<W>(writer: &mut W, response: &Response) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    validate_response_message(response.message(), io::ErrorKind::InvalidInput)?;
    let message = response.message().as_bytes();
    let len = u16::try_from(message.len()).expect("response bound fits in u16");
    let mut frame = Vec::with_capacity(RESPONSE_MAGIC.len() + 3 + message.len());
    frame.extend_from_slice(&RESPONSE_MAGIC);
    frame.push(response.status.code());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(message);
    writer.write_all(&frame).await
}

/// Reads one complete response frame, rejecting oversized messages before
/// allocating space for them.
pub async fn read_response<R>(reader: &mut R) -> io::Result<Response>
where
    R: AsyncRead + Unpin,
{
    read_magic(reader, RESPONSE_MAGIC, "response").await?;
    let status = ResponseStatus::from_code(read_u8(reader).await?)?;
    let len = read_u16(reader).await? as usize;
    if len > MAX_RESPONSE_BYTES {
        return Err(invalid_data(format!(
            "response message length {len} exceeds maximum {MAX_RESPONSE_BYTES}"
        )));
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    let message = String::from_utf8(bytes)
        .map_err(|_| invalid_data("response message is not valid UTF-8"))?;
    validate_response_message(&message, io::ErrorKind::InvalidData)?;
    Ok(Response { status, message })
}

fn encode_request(request: &Request) -> io::Result<Vec<u8>> {
    let mut frame = Vec::with_capacity(32);
    frame.extend_from_slice(&REQUEST_MAGIC);
    match request {
        Request::Ping => frame.push(REQUEST_PING),
        Request::Connect(target) => {
            frame.push(REQUEST_CONNECT);
            encode_target(&mut frame, target)?;
        }
    }
    Ok(frame)
}

fn encode_target(frame: &mut Vec<u8>, target: &Target) -> io::Result<()> {
    target
        .validate()
        .map_err(|err| invalid_input(err.to_string()))?;
    match target {
        Target::Default => frame.push(TARGET_DEFAULT),
        Target::LocalPort(port) => {
            frame.push(TARGET_LOCAL_PORT);
            frame.extend_from_slice(&port.to_be_bytes());
        }
        Target::Tcp { host, port } => {
            frame.push(TARGET_TCP);
            match host {
                Host::Ip(IpAddr::V4(ip)) => {
                    frame.push(HOST_IPV4);
                    frame.extend_from_slice(&ip.octets());
                }
                Host::Ip(IpAddr::V6(ip)) => {
                    frame.push(HOST_IPV6);
                    frame.extend_from_slice(&ip.octets());
                }
                Host::Name(name) => {
                    let name = name.as_str();
                    validate_host_name(name)
                        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
                    let len = u16::try_from(name.len()).expect("hostname bound fits in u16");
                    frame.push(HOST_NAME);
                    frame.extend_from_slice(&len.to_be_bytes());
                    frame.extend_from_slice(name.as_bytes());
                }
            }
            frame.extend_from_slice(&port.to_be_bytes());
        }
    }
    Ok(())
}

async fn read_target<R>(reader: &mut R) -> io::Result<Target>
where
    R: AsyncRead + Unpin,
{
    match read_u8(reader).await? {
        TARGET_DEFAULT => Ok(Target::Default),
        TARGET_LOCAL_PORT => {
            let port = validate_port(read_u16(reader).await?, io::ErrorKind::InvalidData)?;
            Ok(Target::LocalPort(port))
        }
        TARGET_TCP => {
            let host = read_host(reader).await?;
            let port = validate_port(read_u16(reader).await?, io::ErrorKind::InvalidData)?;
            Ok(Target::Tcp { host, port })
        }
        kind => Err(invalid_data(format!("unknown target kind {kind}"))),
    }
}

async fn read_host<R>(reader: &mut R) -> io::Result<Host>
where
    R: AsyncRead + Unpin,
{
    match read_u8(reader).await? {
        HOST_IPV4 => {
            let mut octets = [0; 4];
            reader.read_exact(&mut octets).await?;
            Ok(Host::Ip(Ipv4Addr::from(octets).into()))
        }
        HOST_IPV6 => {
            let mut octets = [0; 16];
            reader.read_exact(&mut octets).await?;
            Ok(Host::Ip(Ipv6Addr::from(octets).into()))
        }
        HOST_NAME => {
            let len = read_u16(reader).await? as usize;
            if len > MAX_HOST_BYTES {
                return Err(invalid_data(format!(
                    "hostname length {len} exceeds maximum {MAX_HOST_BYTES}"
                )));
            }
            let mut bytes = vec![0; len];
            reader.read_exact(&mut bytes).await?;
            let name = String::from_utf8(bytes)
                .map_err(|_| invalid_data("hostname is not valid UTF-8"))?;
            let name = HostName::from_string(name)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            Ok(Host::Name(name))
        }
        kind => Err(invalid_data(format!("unknown host kind {kind}"))),
    }
}

async fn read_magic<R>(reader: &mut R, expected: [u8; 4], kind: &str) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut actual = [0; 4];
    reader.read_exact(&mut actual).await?;
    if actual != expected {
        return Err(invalid_data(format!(
            "invalid or unsupported Burrow {kind} frame"
        )));
    }
    Ok(())
}

async fn read_u8<R>(reader: &mut R) -> io::Result<u8>
where
    R: AsyncRead + Unpin,
{
    let mut byte = [0];
    reader.read_exact(&mut byte).await?;
    Ok(byte[0])
}

async fn read_u16<R>(reader: &mut R) -> io::Result<u16>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = [0; 2];
    reader.read_exact(&mut bytes).await?;
    Ok(u16::from_be_bytes(bytes))
}

fn validate_host_name(name: &str) -> Result<(), ParseHostNameError> {
    if name.is_empty() {
        return Err(ParseHostNameError("hostname is empty".into()));
    }
    if name.len() > MAX_HOST_BYTES {
        return Err(ParseHostNameError(format!(
            "hostname is {} bytes; maximum is {MAX_HOST_BYTES}",
            name.len()
        )));
    }
    if name
        .chars()
        .any(|ch| is_terminal_control(ch) || ch.is_whitespace() || ch == ':')
    {
        return Err(ParseHostNameError(
            "hostname contains whitespace, a terminal control character, or ':'".into(),
        ));
    }
    Ok(())
}

fn validate_port(port: u16, kind: io::ErrorKind) -> io::Result<u16> {
    if port == 0 {
        Err(io::Error::new(kind, "TCP port 0 is not a destination"))
    } else {
        Ok(port)
    }
}

fn validate_response_message(message: &str, kind: io::ErrorKind) -> io::Result<()> {
    if message.len() > MAX_RESPONSE_BYTES {
        return Err(io::Error::new(
            kind,
            format!(
                "response message is {} bytes; maximum is {MAX_RESPONSE_BYTES}",
                message.len()
            ),
        ));
    }
    if message.chars().any(is_terminal_control) {
        return Err(io::Error::new(
            kind,
            "response message contains a terminal control character",
        ));
    }
    Ok(())
}

pub(crate) fn sanitize_diagnostic(message: &str) -> String {
    let mut sanitized = String::with_capacity(message.len().min(MAX_RESPONSE_BYTES));
    let mut boundaries = Vec::new();
    let mut truncated = false;
    for ch in message.chars() {
        let escaped;
        let mut utf8 = [0; 4];
        let rendered = if is_terminal_control(ch) {
            escaped = ch.escape_default().collect::<String>();
            escaped.as_str()
        } else {
            ch.encode_utf8(&mut utf8)
        };
        if sanitized.len() + rendered.len() > MAX_RESPONSE_BYTES {
            truncated = true;
            break;
        }
        boundaries.push(sanitized.len());
        sanitized.push_str(rendered);
    }
    if truncated {
        while sanitized.len() + '…'.len_utf8() > MAX_RESPONSE_BYTES {
            sanitized.truncate(boundaries.pop().unwrap_or(0));
        }
        sanitized.push('…');
    }
    sanitized
}

fn is_terminal_control(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{061c}'
                | '\u{200e}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn invalid_input(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// Error returned when a CLI target is not one of Burrow's accepted forms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseTargetError(String);

impl fmt::Display for ParseTargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for ParseTargetError {}

impl FromStr for Target {
    type Err = ParseTargetError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text.len() > MAX_TARGET_BYTES {
            return Err(ParseTargetError(format!(
                "target is {} bytes; maximum is {MAX_TARGET_BYTES}",
                text.len()
            )));
        }
        if text == "default" {
            return Ok(Self::Default);
        }
        if let Ok(port) = text.parse::<u16>() {
            if port == 0 {
                return Err(ParseTargetError("TCP port 0 is not a destination".into()));
            }
            return Ok(Self::LocalPort(port));
        }
        if let Ok(addr) = text.parse::<SocketAddr>() {
            if addr.port() == 0 {
                return Err(ParseTargetError("TCP port 0 is not a destination".into()));
            }
            return Ok(Self::Tcp {
                host: Host::Ip(addr.ip()),
                port: addr.port(),
            });
        }

        let (host, port) = text.rsplit_once(':').ok_or_else(|| {
            ParseTargetError(format!(
                "invalid target {text:?}; expected default, a port, or host:port"
            ))
        })?;
        if host.is_empty() {
            return Err(ParseTargetError("target hostname is empty".into()));
        }
        let port = port
            .parse::<u16>()
            .map_err(|_| ParseTargetError(format!("invalid port {port:?} in target {text:?}")))?;
        if port == 0 {
            return Err(ParseTargetError("TCP port 0 is not a destination".into()));
        }
        let host = match host.parse::<IpAddr>() {
            Ok(ip) => Host::Ip(ip),
            Err(_) => Host::Name(
                host.parse()
                    .map_err(|err: ParseHostNameError| ParseTargetError(err.to_string()))?,
            ),
        };
        Ok(Self::Tcp { host, port })
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Default => f.write_str("default"),
            Self::LocalPort(port) => write!(f, "{port}"),
            Self::Tcp {
                host: Host::Ip(ip),
                port,
            } => write!(f, "{}", SocketAddr::new(*ip, *port)),
            Self::Tcp {
                host: Host::Name(name),
                port,
            } => write!(f, "{}:{port}", name.as_str()),
        }
    }
}

#[cfg(test)]
#[path = "../tests/core/protocol.rs"]
mod tests;
