// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Mailboxes: values from Rust threads, for Scheme's event loop.
//!
//! Scheme objects belong to the Scheme thread, so a Rust component running
//! threads of its own -- a QUIC endpoint, a file watcher -- sends plain Rust
//! values into a [`Mailbox`], and Scheme takes them, converting each on its
//! own thread. The mailbox's file descriptor becomes readable when values
//! are waiting, so the Scheme side polls it with everything else it waits
//! on.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

struct Inner<T> {
    queue: Mutex<VecDeque<T>>,
    // The Mailbox is gone: nobody will read.
    closed: AtomicBool,
    wake: Wake,
}

/// The receiving end, for Scheme: usually wrapped in an
/// [`crate::Object`].
pub struct Mailbox<T> {
    inner: Arc<Inner<T>>,
}

/// The sending end, for any thread.
pub struct Sender<T> {
    inner: Arc<Inner<T>>,
}

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Sender<T> {
        Sender {
            inner: self.inner.clone(),
        }
    }
}

impl<T> Mailbox<T> {
    pub fn new() -> std::io::Result<(Sender<T>, Mailbox<T>)> {
        let inner = Arc::new(Inner {
            queue: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
            wake: Wake::new()?,
        });
        Ok((
            Sender {
                inner: inner.clone(),
            },
            Mailbox { inner },
        ))
    }

    /// Readable while values wait.
    pub fn fd(&self) -> i32 {
        self.inner.wake.fd()
    }

    /// Every value waiting, oldest first.
    pub fn take(&self) -> Vec<T> {
        self.inner.wake.drain();
        self.inner.queue.lock().unwrap().drain(..).collect()
    }
}

impl<T> Drop for Mailbox<T> {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::Release);
    }
}

impl<T> Sender<T> {
    /// Queue a value; it comes back if the mailbox has been dropped.
    pub fn send(&self, value: T) -> Result<(), T> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(value);
        }
        let mut queue = self.inner.queue.lock().unwrap();
        let first = queue.is_empty();
        queue.push_back(value);
        drop(queue);
        // Only the first value waiting wakes the reader: the others are
        // taken with it. The reader empties the pipe before the queue, so
        // a wake can come with nothing to take, but never be missed.
        if first {
            self.inner.wake.wake();
        }
        Ok(())
    }
}

/// What wakes the reader: a pipe on Unix, which Scheme polls; a socket
/// pair on Windows, where Scheme waits on sockets alone (socket.rs). Both
/// ends are non-blocking: the reader drains what is there, and a full
/// buffer already says there is something to read.
#[cfg(unix)]
struct Wake {
    read_fd: i32,
    write_fd: i32,
}

#[cfg(unix)]
impl Wake {
    /// A pipe whose ends are non-blocking and close-on-exec: made so at
    /// once where the system can (Linux's pipe2), else just after (macOS).
    fn new() -> std::io::Result<Wake> {
        let mut fds = [0i32; 2];
        // SAFETY: room for the two descriptors.
        #[cfg(target_os = "linux")]
        let made = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) };
        // SAFETY: as for pipe2.
        #[cfg(not(target_os = "linux"))]
        let made = unsafe { libc::pipe(fds.as_mut_ptr()) };
        if made != 0 {
            return Err(std::io::Error::last_os_error());
        }
        #[cfg(not(target_os = "linux"))]
        for fd in fds {
            // SAFETY: the descriptors just made, which are ours alone.
            unsafe {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                libc::fcntl(
                    fd,
                    libc::F_SETFL,
                    libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
                );
            }
        }
        Ok(Wake {
            read_fd: fds[0],
            write_fd: fds[1],
        })
    }

    fn fd(&self) -> i32 {
        self.read_fd
    }

    fn drain(&self) {
        let mut buf = [0u8; 256];
        // SAFETY: reads into `buf`, from the pipe's own read end.
        while unsafe { libc::read(self.read_fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
    }

    fn wake(&self) {
        let b = 1u8;
        // SAFETY: one byte, from `b`, to the pipe's own write end.
        unsafe { libc::write(self.write_fd, (&b as *const u8).cast(), 1) };
    }
}

#[cfg(unix)]
impl Drop for Wake {
    fn drop(&mut self) {
        // SAFETY: the pipe's ends, ours alone, closed once.
        unsafe {
            libc::close(self.read_fd);
            libc::close(self.write_fd);
        }
    }
}

#[cfg(windows)]
struct Wake {
    read: std::net::TcpStream,
    write: std::net::TcpStream,
}

#[cfg(windows)]
impl Wake {
    fn new() -> std::io::Result<Wake> {
        let (read, write) = crate::socket::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        Ok(Wake { read, write })
    }

    fn fd(&self) -> i32 {
        crate::socket::descriptor(&self.read)
    }

    fn drain(&self) {
        use std::io::Read as _;
        let mut buf = [0u8; 256];
        while (&self.read).read(&mut buf).is_ok_and(|n| n > 0) {}
    }

    fn wake(&self) {
        use std::io::Write as _;
        let _ = (&self.write).write(&[1]);
    }
}
