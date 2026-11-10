// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Socket pairs, for what Scheme waits on where descriptors are sockets.
//!
//! On Windows the kernel (os-windows.c) waits on everything with WSAPoll,
//! which takes sockets alone: every descriptor the Rust half hands Scheme
//! to wait on, read or write -- a [`crate::Mailbox`]'s, a mesh stream's, a
//! subprocess's pipes, pumped -- is a socket, its `SOCKET` as an `i32`
//! (Windows keeps them within 32 bits). Windows has no socketpair(2), so a
//! pair is made as os-windows.c's `socket_pair` makes one: over loopback
//! TCP. Unix has pipes and socketpair(2), and uses them; this compiles
//! everywhere, all the same, so that its tests run everywhere.

use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};

/// A connected pair of blocking stream sockets, as socketpair(2) makes:
/// through a loopback listener that lives only as long as this call. The
/// connection accepted is checked to be the one made here, so that another
/// process connecting to the listener in between cannot take its place;
/// one that did is closed. Neither socket is inherited by the programs
/// this process runs, and neither delays small writes (Nagle's algorithm
/// off): they carry a byte that wakes a waiter, or an interactive stream.
pub fn pair() -> io::Result<(TcpStream, TcpStream)> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let connecting = TcpStream::connect(listener.local_addr()?)?;
    let mine = connecting.local_addr()?;
    let accepted = loop {
        let (accepted, peer) = listener.accept()?;
        if same(peer, mine) {
            break accepted;
        }
        let _ = accepted.shutdown(Shutdown::Both);
    };
    drop(listener);
    for s in [&accepted, &connecting] {
        not_inherited(s)?;
        s.set_nodelay(true)?;
        // A listener's accepted socket takes its blocking mode, which is
        // blocking; made so all the same.
        s.set_nonblocking(false)?;
    }
    Ok((accepted, connecting))
}

fn same(a: SocketAddr, b: SocketAddr) -> bool {
    a.ip() == b.ip() && a.port() == b.port()
}

/// The socket, as the `i32` Scheme has for it (os-windows.c's descriptors).
#[cfg(windows)]
pub fn descriptor(s: &impl std::os::windows::io::AsRawSocket) -> i32 {
    // SOCKETs are handles, which Windows keeps within 32 bits.
    s.as_raw_socket() as u32 as i32
}

/// The socket the `i32` Scheme has stands for (os-windows.c's
/// `(SOCKET)(uintptr_t)(unsigned)fd`).
#[cfg(windows)]
pub fn raw_socket(fd: i32) -> std::os::windows::io::RawSocket {
    fd as u32 as std::os::windows::io::RawSocket
}

/// Std makes its sockets with WSA_FLAG_NO_HANDLE_INHERIT, and an accepted
/// socket takes its listener's; this makes sure, as os-windows.c does.
#[cfg(windows)]
fn not_inherited(s: &TcpStream) -> io::Result<()> {
    use std::os::windows::io::AsRawSocket as _;
    use windows::Win32::Foundation::{
        HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAGS, SetHandleInformation,
    };
    // SAFETY: the socket is a live handle, ours; only its flags change.
    unsafe {
        SetHandleInformation(
            HANDLE(s.as_raw_socket() as usize as *mut core::ffi::c_void),
            HANDLE_FLAG_INHERIT.0,
            HANDLE_FLAGS(0),
        )
    }
    .map_err(|e| io::Error::other(e.to_string()))
}

/// Std makes its sockets close-on-exec on Unix.
#[cfg(not(windows))]
fn not_inherited(_: &TcpStream) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read as _, Write as _};

    use super::*;

    #[test]
    fn a_pair_is_connected_both_ways() {
        let (mut a, mut b) = pair().unwrap();
        assert_eq!(a.peer_addr().unwrap(), b.local_addr().unwrap());
        assert!(a.nodelay().unwrap() && b.nodelay().unwrap());
        a.write_all(b"ping").unwrap();
        let mut buf = [0u8; 4];
        b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
        b.write_all(b"pong").unwrap();
        a.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"pong");
        // Shutting one end down is end of file at the other.
        a.shutdown(Shutdown::Write).unwrap();
        assert_eq!(b.read(&mut buf).unwrap(), 0);
    }
}
