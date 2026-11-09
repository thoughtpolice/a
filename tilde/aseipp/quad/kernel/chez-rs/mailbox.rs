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
    read_fd: i32,
    write_fd: i32,
}

impl<T> Drop for Inner<T> {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.read_fd);
            libc::close(self.write_fd);
        }
    }
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

/// A pipe whose ends are non-blocking and close-on-exec: made so at once
/// where the system can (Linux's pipe2), else just after (macOS).
fn pipe() -> std::io::Result<[i32; 2]> {
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
    Ok(fds)
}

impl<T> Mailbox<T> {
    pub fn new() -> std::io::Result<(Sender<T>, Mailbox<T>)> {
        let fds = pipe()?;
        let inner = Arc::new(Inner {
            queue: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
            read_fd: fds[0],
            write_fd: fds[1],
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
        self.inner.read_fd
    }

    /// Every value waiting, oldest first.
    pub fn take(&self) -> Vec<T> {
        let mut buf = [0u8; 256];
        while unsafe { libc::read(self.inner.read_fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
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
        self.inner.queue.lock().unwrap().push_back(value);
        let b = 1u8;
        // A full pipe already says there is something to read.
        unsafe { libc::write(self.inner.write_fd, (&b as *const u8).cast(), 1) };
        Ok(())
    }

    /// Whether the mailbox is gone.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }
}
