// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// os-windows.c -- the kernel's primitives on Windows (os.h).
//
// Scheme waits on everything at once -- the terminal, the listening socket,
// each client's connection, the Rust half's mailboxes, subprocess pipes --
// through quad_poll_rw, and on Unix each of those is a descriptor poll(2)
// takes. Windows has no one wait over consoles, pipes and sockets, but
// WSAPoll waits over sockets of any kind; so here every stream Scheme waits
// on is a socket, and its "descriptor" the SOCKET, which Windows keeps
// within 32 bits:
//
//   - connections are AF_UNIX sockets, which Windows has had since 10 1803;
//   - what the Rust half and the kernel make for Scheme to wait on are
//     socket pairs over loopback (socket_pair; chez-rs makes its own);
//   - what is not a socket -- the console, a pipe -- is pumped into one, by
//     a thread of its own (pump_*), the console's turning input records
//     into the bytes a terminal sends (console_reader);
//   - signals are console control events, which wake a waiter through a
//     socket pair as Unix's handlers do through a pipe.
//
// Descriptors 0, 1 and 2 still name the standard streams, which no socket
// is ever numbered; a descriptor that is neither, such as quad_lock's, is a
// HANDLE, which closesocket refuses with WSAENOTSOCK and CloseHandle takes.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <afunix.h>
#include <windows.h>
#include <aclapi.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "os.h"

static volatile LONG g_winch = 0;
static volatile LONG g_stop = 0;

/* -------------------------------------------------------------------------- */
/* -- Strings --------------------------------------------------------------- */

// path, UTF-8, as UTF-16 for the W functions; free it after.
static wchar_t*
widen(const char* s)
{
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t* w = malloc((size_t)n * sizeof(wchar_t));
  if (w && MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n) <= 0) {
    free(w);
    return NULL;
  }
  return w;
}

/* -------------------------------------------------------------------------- */
/* -- Sockets --------------------------------------------------------------- */

static SOCKET
make_socket(int family, int type, int protocol)
{
  // Not inherited: the programs the editor runs get none of the kernel's.
  return WSASocketW(family, type, protocol, NULL, 0, WSA_FLAG_NO_HANDLE_INHERIT);
}

static void
set_nonblocking(SOCKET s, int on)
{
  u_long v = on ? 1 : 0;
  ioctlsocket(s, FIONBIO, &v);
}

// A connected pair of stream sockets, as socketpair(2) makes on Unix: over
// loopback TCP, through a listener that lives only as long as this call. The
// connection accepted is checked to be the one made here, so that another
// process connecting to the listener in between cannot take its place.
static int
socket_pair(SOCKET out[2])
{
  SOCKET listener = make_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET) return -1;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int len = sizeof(addr);
  SOCKET c = INVALID_SOCKET, a = INVALID_SOCKET;
  if (bind(listener, (struct sockaddr*)&addr, sizeof(addr)) != 0
      || getsockname(listener, (struct sockaddr*)&addr, &len) != 0 || listen(listener, 8) != 0)
    goto fail;
  c = make_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (c == INVALID_SOCKET || connect(c, (struct sockaddr*)&addr, sizeof(addr)) != 0) goto fail;
  struct sockaddr_in mine;
  int mine_len = sizeof(mine);
  if (getsockname(c, (struct sockaddr*)&mine, &mine_len) != 0) goto fail;
  for (;;) {
    struct sockaddr_in peer;
    int peer_len = sizeof(peer);
    a = accept(listener, (struct sockaddr*)&peer, &peer_len);
    if (a == INVALID_SOCKET) goto fail;
    if (peer.sin_port == mine.sin_port && peer.sin_addr.s_addr == mine.sin_addr.s_addr) break;
    closesocket(a);
  }
  SetHandleInformation((HANDLE)a, HANDLE_FLAG_INHERIT, 0);
  closesocket(listener);
  BOOL on = TRUE;
  setsockopt(a, IPPROTO_TCP, TCP_NODELAY, (const char*)&on, sizeof(on));
  setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char*)&on, sizeof(on));
  out[0] = a;
  out[1] = c;
  return 0;
fail:
  if (c != INVALID_SOCKET) closesocket(c);
  closesocket(listener);
  return -1;
}

// Send all of buf[0..n) on a blocking socket: n, or -1.
static int
send_all(SOCKET s, const char* buf, int n)
{
  int done = 0;
  while (done < n) {
    int r = send(s, buf + done, n - done, 0);
    if (r == SOCKET_ERROR) {
      if (WSAGetLastError() == WSAEWOULDBLOCK) {
        WSAPOLLFD p = {.fd = s, .events = POLLWRNORM};
        WSAPoll(&p, 1, -1);
        continue;
      }
      return -1;
    }
    done += r;
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* -- Waking ---------------------------------------------------------------- */

// A socket pair a console control event writes a byte to, which quad_poll_rw
// and quad_read wait on too, as the Unix kernel's signal pipe.
static SOCKET g_wake[2] = {INVALID_SOCKET, INVALID_SOCKET};

static void
wake_open(void)
{
  if (socket_pair(g_wake) != 0) {
    g_wake[0] = g_wake[1] = INVALID_SOCKET;
    return;
  }
  set_nonblocking(g_wake[0], 1);
  set_nonblocking(g_wake[1], 1);
}

static void
wake(void)
{
  if (g_wake[1] != INVALID_SOCKET) send(g_wake[1], "", 1, 0);
}

static void
wake_drain(void)
{
  char buf[64];
  while (g_wake[0] != INVALID_SOCKET && recv(g_wake[0], buf, sizeof(buf), 0) > 0) {}
}

// The console's close button, a logoff or a shutdown: the editor is asked to
// stop, as SIGTERM and SIGHUP ask on Unix. Windows ends the process when the
// handler returns, so it waits for the editor to, for as long as Windows
// allows (five seconds for a close). ^C and ^Break do what they would have
// done, as SIGINT does on Unix: in raw mode they are keys like any other.
static BOOL WINAPI
on_console_event(DWORD event)
{
  switch (event) {
  case CTRL_CLOSE_EVENT:
  case CTRL_LOGOFF_EVENT:
  case CTRL_SHUTDOWN_EVENT:
    if (InterlockedExchange(&g_stop, 1)) return FALSE;
    wake();
    Sleep(INFINITE);
    return TRUE;
  default:
    return FALSE;
  }
}

/* -------------------------------------------------------------------------- */
/* -- Pumps ----------------------------------------------------------------- */

// A HANDLE that is not a socket (a pipe), and the socket that stands for it.
struct pump {
  HANDLE handle;
  SOCKET socket;
};

// Copies what the handle reads into the socket, until either ends.
static DWORD WINAPI
pump_from_handle(void* arg)
{
  struct pump* p = arg;
  char buf[4096];
  DWORD got;
  while (ReadFile(p->handle, buf, sizeof(buf), &got, NULL) && got > 0)
    if (send_all(p->socket, buf, (int)got) < 0) break;
  shutdown(p->socket, SD_SEND);
  closesocket(p->socket);
  CloseHandle(p->handle);
  free(p);
  return 0;
}

// Copies what the socket receives into the handle, until either ends.
static DWORD WINAPI
pump_to_handle(void* arg)
{
  struct pump* p = arg;
  char buf[4096];
  int got;
  while ((got = recv(p->socket, buf, sizeof(buf), 0)) > 0) {
    DWORD done = 0;
    while (done < (DWORD)got) {
      DWORD wrote;
      if (!WriteFile(p->handle, buf + done, (DWORD)got - done, &wrote, NULL)) goto out;
      done += wrote;
    }
  }
out:
  closesocket(p->socket);
  CloseHandle(p->handle);
  free(p);
  return 0;
}

// A socket for Scheme that reads what handle does (to_handle false), or
// writes to it (true); the pump owns handle from here on. INVALID_SOCKET, if
// the pump cannot be made.
static SOCKET
pump(HANDLE handle, int to_handle)
{
  SOCKET pair[2];
  if (socket_pair(pair) != 0) return INVALID_SOCKET;
  struct pump* p = malloc(sizeof(*p));
  if (!p) goto fail;
  p->handle = handle;
  p->socket = pair[1];
  HANDLE t = CreateThread(NULL, 64 << 10, to_handle ? pump_to_handle : pump_from_handle, p, 0, NULL);
  if (!t) {
    free(p);
    goto fail;
  }
  CloseHandle(t);
  return pair[0];
fail:
  closesocket(pair[0]);
  closesocket(pair[1]);
  return INVALID_SOCKET;
}

/* -------------------------------------------------------------------------- */
/* -- Terminal primitives --------------------------------------------------- */

// Standard input, as a socket: made when Scheme first waits on or reads
// descriptor 0.
static SOCKET g_stdin = INVALID_SOCKET;
static SRWLOCK g_stdin_lock = SRWLOCK_INIT;

// The console's modes and code pages as they were before quad_tty_raw.
static DWORD g_saved_in_mode, g_saved_out_mode;
static UINT g_saved_in_cp, g_saved_out_cp;
static int g_raw = 0;

static HANDLE
std_handle(int fd)
{
  switch (fd) {
  case 0: return GetStdHandle(STD_INPUT_HANDLE);
  case 1: return GetStdHandle(STD_OUTPUT_HANDLE);
  case 2: return GetStdHandle(STD_ERROR_HANDLE);
  default: return INVALID_HANDLE_VALUE;
  }
}

static int
is_console(HANDLE h)
{
  DWORD mode;
  return h != NULL && h != INVALID_HANDLE_VALUE && GetConsoleMode(h, &mode);
}

// Appends the UTF-8 of code point c to out, returning how many bytes.
static int
utf8(unsigned c, char* out)
{
  if (c < 0x80) {
    out[0] = (char)c;
    return 1;
  } else if (c < 0x800) {
    out[0] = (char)(0xC0 | (c >> 6));
    out[1] = (char)(0x80 | (c & 0x3F));
    return 2;
  } else if (c < 0x10000) {
    out[0] = (char)(0xE0 | (c >> 12));
    out[1] = (char)(0x80 | ((c >> 6) & 0x3F));
    out[2] = (char)(0x80 | (c & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (c >> 18));
  out[1] = (char)(0x80 | ((c >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((c >> 6) & 0x3F));
  out[3] = (char)(0x80 | (c & 0x3F));
  return 4;
}

// The console's input, as the bytes a terminal sends. With
// ENABLE_VIRTUAL_TERMINAL_INPUT (quad_tty_raw) the console encodes every key
// as a terminal would, escape sequences and all, and a key event carries a
// UTF-16 unit of them; a resize is an event of its own, which is SIGWINCH's
// part on Unix.
static DWORD WINAPI
console_reader(void* arg)
{
  SOCKET out = (SOCKET)(uintptr_t)arg;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  INPUT_RECORD records[64];
  unsigned high = 0;
  for (;;) {
    DWORD n;
    if (!ReadConsoleInputW(in, records, 64, &n)) break;
    char buf[64 * 4 * 2];
    int len = 0;
    for (DWORD i = 0; i < n; i++) {
      if (records[i].EventType == WINDOW_BUFFER_SIZE_EVENT) {
        InterlockedExchange(&g_winch, 1);
        wake();
        continue;
      }
      if (records[i].EventType != KEY_EVENT) continue;
      KEY_EVENT_RECORD* k = &records[i].Event.KeyEvent;
      unsigned u = k->uChar.UnicodeChar;
      if (!k->bKeyDown || u == 0) continue;
      for (WORD r = 0; r < (k->wRepeatCount ? k->wRepeatCount : 1); r++) {
        if (u >= 0xD800 && u < 0xDC00) {
          high = u;
          continue;
        }
        unsigned c = u;
        if (u >= 0xDC00 && u < 0xE000) {
          if (!high) continue;
          c = 0x10000 + ((high - 0xD800) << 10) + (u - 0xDC00);
        }
        high = 0;
        if (len > (int)sizeof(buf) - 4) {
          if (send_all(out, buf, len) < 0) goto done;
          len = 0;
        }
        len += utf8(c, buf + len);
      }
    }
    if (len > 0 && send_all(out, buf, len) < 0) break;
  }
done:
  closesocket(out);
  return 0;
}

// Standard input as a socket Scheme can wait on: the console's input through
// console_reader, or a pipe's or a file's through a pump.
static SOCKET
stdin_socket(void)
{
  AcquireSRWLockExclusive(&g_stdin_lock);
  if (g_stdin == INVALID_SOCKET) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (is_console(in)) {
      SOCKET pair[2];
      if (socket_pair(pair) == 0) {
        HANDLE t = CreateThread(NULL, 64 << 10, console_reader, (void*)(uintptr_t)pair[1], 0, NULL);
        if (t) {
          CloseHandle(t);
          g_stdin = pair[0];
        } else {
          closesocket(pair[0]);
          closesocket(pair[1]);
        }
      }
    } else if (in != NULL && in != INVALID_HANDLE_VALUE) {
      HANDLE dup;
      if (DuplicateHandle(GetCurrentProcess(), in, GetCurrentProcess(), &dup, 0, FALSE, DUPLICATE_SAME_ACCESS))
        g_stdin = pump(dup, 0);
    }
  }
  SOCKET s = g_stdin;
  ReleaseSRWLockExclusive(&g_stdin_lock);
  return s;
}

// The socket Scheme's descriptor fd waits on.
static SOCKET
waitable(int fd)
{
  if (fd < 0) return INVALID_SOCKET;
  return fd == 0 ? stdin_socket() : (SOCKET)(uintptr_t)(unsigned)fd;
}

static void
restore_at_exit(void)
{
  if (g_raw) {
    // Leave the alternate screen, pop the keyboard mode, and show the cursor.
    static const char reset[] =
        "\x1b[<u\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[0 q\x1b[?1049l";
    DWORD wrote;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), reset, sizeof(reset) - 1, &wrote, NULL);
    quad_tty_restore(0);
  }
}

int
quad_isatty(int fd)
{
  return is_console(std_handle(fd));
}

int
quad_tty_raw(int fd)
{
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE), out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (fd != 0 || !GetConsoleMode(in, &g_saved_in_mode) || !GetConsoleMode(out, &g_saved_out_mode))
    return -1;
  g_saved_in_cp = GetConsoleCP();
  g_saved_out_cp = GetConsoleOutputCP();
  // Keys as a terminal sends them, and resizes; no line editing, echo, ^C
  // handling or mouse selection (quick edit) of the console's own.
  if (!SetConsoleMode(in, ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT | ENABLE_EXTENDED_FLAGS))
    return -1;
  // Escape sequences, interpreted as a terminal does, and no carriage return
  // after a line feed but where the editor writes one.
  if (!SetConsoleMode(out, ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
                               | DISABLE_NEWLINE_AUTO_RETURN)) {
    SetConsoleMode(in, g_saved_in_mode);
    return -1;
  }
  SetConsoleCP(CP_UTF8);
  SetConsoleOutputCP(CP_UTF8);
  if (!g_raw) {
    static int registered = 0;
    if (!registered) {
      atexit(restore_at_exit);
      registered = 1;
    }
  }
  g_raw = 1;
  return 0;
}

int
quad_tty_restore(int fd)
{
  (void)fd;
  if (!g_raw) return 0;
  g_raw = 0;
  SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), g_saved_in_mode);
  SetConsoleMode(GetStdHandle(STD_OUTPUT_HANDLE), g_saved_out_mode);
  SetConsoleCP(g_saved_in_cp);
  SetConsoleOutputCP(g_saved_out_cp);
  return 0;
}

// The window size as rows * 65536 + cols, or -1.
int
quad_tty_size(int fd)
{
  (void)fd;
  CONSOLE_SCREEN_BUFFER_INFO info;
  if (!GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &info)) return -1;
  int rows = info.srWindow.Bottom - info.srWindow.Top + 1;
  int cols = info.srWindow.Right - info.srWindow.Left + 1;
  if (cols <= 0 || rows <= 0) return -1;
  return (rows << 16) | cols;
}

// The console does not say its size in pixels.
int
quad_tty_pixels(int fd)
{
  (void)fd;
  return -1;
}

// Wait up to timeout_ms (forever if negative) for input, then read up to n
// bytes into buf. Returns the count read, 0 on timeout, -2 if interrupted
// (a resize, say), and -1 on error or end of file.
int
quad_read(int fd, unsigned char* buf, int n, int timeout_ms)
{
  SOCKET s = waitable(fd);
  if (s == INVALID_SOCKET) return -1;
  WSAPOLLFD p[2] = {{.fd = s, .events = POLLRDNORM}, {.fd = g_wake[0], .events = POLLRDNORM}};
  int r = WSAPoll(p, g_wake[0] != INVALID_SOCKET ? 2 : 1, timeout_ms);
  if (r < 0) return -1;
  if (r == 0) return 0;
  if (p[1].revents) wake_drain();
  if (!p[0].revents) return -2;
  int got = recv(s, (char*)buf, n, 0);
  if (got == SOCKET_ERROR) {
    int e = WSAGetLastError();
    if (e == WSAEWOULDBLOCK || e == WSAEINTR) return -2;
    if (e == WSAENOTSOCK) {
      DWORD n_read;
      if (!ReadFile((HANDLE)(uintptr_t)s, buf, (DWORD)n, &n_read, NULL) || n_read == 0) return -1;
      return (int)n_read;
    }
    return -1;
  }
  if (got == 0) return -1;
  // Whatever else has arrived, without waiting: a Windows stream socket
  // gives a recv each send's bytes apart, where Unix's read takes what is
  // there, so a message written in parts would otherwise take a wait for
  // each.
  u_long more;
  while (got < n && ioctlsocket(s, FIONREAD, &more) == 0 && more > 0) {
    int r = recv(s, (char*)buf + got, n - got, 0);
    if (r <= 0) break;
    got += r;
  }
  return got;
}

// Write all of buf[0..n), returning n or -1.
int
quad_write(int fd, const unsigned char* buf, int n)
{
  HANDLE h = fd == 1 || fd == 2 ? std_handle(fd) : INVALID_HANDLE_VALUE;
  if (h == INVALID_HANDLE_VALUE && fd > 2) {
    int r = send_all((SOCKET)(uintptr_t)(unsigned)fd, (const char*)buf, n);
    if (r >= 0 || WSAGetLastError() != WSAENOTSOCK) return r;
    h = (HANDLE)(uintptr_t)(unsigned)fd;
  }
  if (h == INVALID_HANDLE_VALUE || h == NULL) return -1;
  int done = 0;
  while (done < n) {
    DWORD wrote;
    if (!WriteFile(h, buf + done, (DWORD)(n - done), &wrote, NULL) || wrote == 0) return -1;
    done += (int)wrote;
  }
  return n;
}

// Returns and clears the resize flag.
int
quad_take_winch(void)
{
  return InterlockedExchange(&g_winch, 0);
}

// 1 once the editor is asked to stop (the console closes, a logoff, a
// shutdown), else 0.
int
quad_stop_requested(void)
{
  return g_stop;
}

// Windows has no job control: there is nothing to suspend to.
void
quad_suspend(void)
{
}

/* -------------------------------------------------------------------------- */
/* -- Connections ----------------------------------------------------------- */

// Wait up to timeout_ms (forever if negative) for any of fds[0..n) to be
// ready as events[i] asks: 1, readable (or hung up, or in error); 2,
// writable; 3, either. ready[i] is set to what each is, likewise. Returns
// the number ready, 0 on timeout, -2 if interrupted, -1 on error.
int
quad_poll_rw(const int* fds, const int* events, int n, int timeout_ms, int* ready)
{
  WSAPOLLFD on_stack[65];
  WSAPOLLFD* ps = n < 65 ? on_stack : malloc((size_t)(n + 1) * sizeof(WSAPOLLFD));
  if (!ps) return -1;
  // The standard output and error are always writable, as a terminal is.
  int always = 0;
  int m = 0;
  for (int i = 0; i < n; i++) {
    ready[i] = 0;
    if ((fds[i] == 1 || fds[i] == 2) && (events[i] & 2)) always = 1;
  }
  int* index = malloc((size_t)(n + 1) * sizeof(int));
  if (!index) {
    if (ps != on_stack) free(ps);
    return -1;
  }
  for (int i = 0; i < n; i++) {
    // A negative descriptor is never ready, as poll(2) has it: a source
    // with none waits only for its timeout.
    if (fds[i] < 0 || fds[i] == 1 || fds[i] == 2) continue;
    SOCKET s = waitable(fds[i]);
    if (s == INVALID_SOCKET) {
      ready[i] = events[i] & 3;
      always = 1;
      continue;
    }
    ps[m].fd = s;
    ps[m].events = (SHORT)(((events[i] & 1) ? POLLRDNORM : 0) | ((events[i] & 2) ? POLLWRNORM : 0));
    ps[m].revents = 0;
    index[m++] = i;
  }
  int wake_at = -1;
  if (g_wake[0] != INVALID_SOCKET) {
    wake_at = m;
    ps[m].fd = g_wake[0];
    ps[m].events = POLLRDNORM;
    ps[m].revents = 0;
    m++;
  }
  int r = m > 0 ? WSAPoll(ps, (ULONG)m, always ? 0 : timeout_ms) : 0;
  if (m == 0 && !always && timeout_ms != 0) Sleep(timeout_ms < 0 ? INFINITE : (DWORD)timeout_ms);
  int count = 0;
  for (int j = 0; j < m; j++) {
    if (j == wake_at) continue;
    int i = index[j];
    SHORT re = r > 0 ? ps[j].revents : 0;
    int gone = (re & (POLLHUP | POLLERR | POLLNVAL)) != 0;
    ready[i] = (((events[i] & 1) && ((re & POLLRDNORM) || gone)) ? 1 : 0)
               | (((events[i] & 2) && ((re & POLLWRNORM) || gone)) ? 2 : 0);
  }
  for (int i = 0; i < n; i++) {
    if ((fds[i] == 1 || fds[i] == 2) && (events[i] & 2)) ready[i] = 2;
    count += ready[i] != 0;
  }
  int signaled = r > 0 && wake_at >= 0 && ps[wake_at].revents;
  free(index);
  if (ps != on_stack) free(ps);
  if (r < 0) return -1;
  if (signaled) {
    wake_drain();
    if (count == 0) return -2;
  }
  return count;
}

// Write what of buf[start..start+n) a socket takes now, without waiting:
// the count written (0 if it takes none now), or -1 on error. The sockets
// Scheme holds block, so this one stops for the call.
int
quad_write_some(int fd, const unsigned char* buf, int start, int n)
{
  SOCKET s = (SOCKET)(uintptr_t)(unsigned)fd;
  set_nonblocking(s, 1);
  int r = send(s, (const char*)buf + start, n, 0);
  int e = r == SOCKET_ERROR ? WSAGetLastError() : 0;
  set_nonblocking(s, 0);
  if (r >= 0) return r;
  return e == WSAEWOULDBLOCK ? 0 : -1;
}

static int
unix_address(const char* path, struct sockaddr_un* addr)
{
  memset(addr, 0, sizeof(*addr));
  addr->sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr->sun_path)) return -1;
  strcpy(addr->sun_path, path);
  return 0;
}

// Listen on a Unix socket at path, which must not exist; returns the
// listening descriptor, or -1.
int
quad_unix_listen(const char* path)
{
  struct sockaddr_un addr;
  if (unix_address(path, &addr) != 0) return -1;
  SOCKET s = make_socket(AF_UNIX, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return -1;
  if (bind(s, (struct sockaddr*)&addr, sizeof(addr)) != 0 || listen(s, 16) != 0) {
    closesocket(s);
    return -1;
  }
  return (int)s;
}

// Connect to the Unix socket at path; returns the descriptor, or -1.
int
quad_unix_connect(const char* path)
{
  struct sockaddr_un addr;
  if (unix_address(path, &addr) != 0) return -1;
  SOCKET s = make_socket(AF_UNIX, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return -1;
  if (connect(s, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
    closesocket(s);
    return -1;
  }
  return (int)s;
}

int
quad_accept(int fd)
{
  SOCKET s = accept((SOCKET)(uintptr_t)(unsigned)fd, NULL, NULL);
  if (s == INVALID_SOCKET) return -1;
  SetHandleInformation((HANDLE)s, HANDLE_FLAG_INHERIT, 0);
  return (int)s;
}

// The token's user, owner of what it makes, for quad_private_dir.
static int
token_sids(PSID* user, PSID* owner)
{
  static union {
    TOKEN_USER user;
    char buf[256];
  } u;
  static union {
    TOKEN_OWNER owner;
    char buf[256];
  } o;
  HANDLE token;
  DWORD len;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return -1;
  int ok = GetTokenInformation(token, TokenUser, &u, sizeof(u), &len)
           && GetTokenInformation(token, TokenOwner, &o, sizeof(o), &len);
  CloseHandle(token);
  if (!ok) return -1;
  *user = u.user.User.Sid;
  *owner = o.owner.Owner;
  return 0;
}

static int
is_well_known(PSID sid, WELL_KNOWN_SID_TYPE type)
{
  return IsWellKnownSid(sid, type);
}

// 1 if path is a directory that is this user's alone: no link (reparse
// point), owned by the user (or by whom the user's token makes owner of
// what it creates, the Administrators when elevated), and with access for
// nobody else but the system and the administrators, who have it to
// everything anyway. Sockets go only in such a directory, where nobody
// else can put one of their own.
int
quad_private_dir(const char* path)
{
  wchar_t* w = widen(path);
  if (!w) return 0;
  int result = 0;
  PSID owner = NULL, user, token_owner;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD attrs = GetFileAttributesW(w);
  if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)
      || (attrs & FILE_ATTRIBUTE_REPARSE_POINT))
    goto out;
  if (token_sids(&user, &token_owner) != 0) goto out;
  if (GetNamedSecurityInfoW(w, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                            &owner, NULL, &dacl, NULL, &sd)
      != ERROR_SUCCESS)
    goto out;
  if (!owner || !(EqualSid(owner, user) || EqualSid(owner, token_owner))) goto out;
  // A null DACL is access for everyone.
  if (!dacl) goto out;
  for (DWORD i = 0; i < dacl->AceCount; i++) {
    ACE_HEADER* ace;
    if (!GetAce(dacl, i, (void**)&ace)) goto out;
    if (ace->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
    // Only for what is made inside, as CREATOR OWNER's are: it is the
    // creator's, so this user's.
    if (ace->AceFlags & INHERIT_ONLY_ACE) continue;
    PSID sid = (PSID)&((ACCESS_ALLOWED_ACE*)ace)->SidStart;
    if (!(EqualSid(sid, user) || EqualSid(sid, token_owner) || is_well_known(sid, WinLocalSystemSid)
          || is_well_known(sid, WinBuiltinAdministratorsSid) || is_well_known(sid, WinCreatorOwnerSid)))
      goto out;
  }
  result = 1;
out:
  if (sd) LocalFree(sd);
  free(w);
  return result;
}

// A file's identity: its volume and its index there, as a device and an
// inode are on Unix. A Unix socket is a reparse point Windows cannot follow,
// and so is opened as one.
static int
file_id(const char* path, BY_HANDLE_FILE_INFORMATION* info)
{
  wchar_t* w = widen(path);
  if (!w) return -1;
  DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  HANDLE h = CreateFileW(w, FILE_READ_ATTRIBUTES, share, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (h == INVALID_HANDLE_VALUE)
    h = CreateFileW(w, FILE_READ_ATTRIBUTES, share, NULL, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return -1;
  int ok = GetFileInformationByHandle(h, info);
  CloseHandle(h);
  return ok ? 0 : -1;
}

// 1 if paths a and b name the same file (a socket, say), however each is
// spelled: through links, relatively, or with "..".
int
quad_same_file(const char* a, const char* b)
{
  BY_HANDLE_FILE_INFORMATION ia, ib;
  if (file_id(a, &ia) != 0 || file_id(b, &ib) != 0) return 0;
  return ia.dwVolumeSerialNumber == ib.dwVolumeSerialNumber && ia.nFileIndexHigh == ib.nFileIndexHigh
         && ia.nFileIndexLow == ib.nFileIndexLow;
}

// Takes the lock at path (a file made if need be), waiting for whoever has
// it: the descriptor that holds it, which closing gives back, or -1.
int
quad_lock(const char* path)
{
  wchar_t* w = widen(path);
  if (!w) return -1;
  HANDLE h = CreateFileW(w, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return -1;
  OVERLAPPED at;
  memset(&at, 0, sizeof(at));
  if (!LockFileEx(h, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &at)) {
    CloseHandle(h);
    return -1;
  }
  return (int)(uintptr_t)h;
}

// What file path is, as "volume:index" (written to out, of n bytes): to
// tell later whether path is still that file. Its length, or -1 if there is
// none.
int
quad_file_key(const char* path, char* out, int n)
{
  BY_HANDLE_FILE_INFORMATION info;
  if (file_id(path, &info) != 0) return -1;
  int w = snprintf(out, (size_t)n, "%lu:%llu", (unsigned long)info.dwVolumeSerialNumber,
                   ((unsigned long long)info.nFileIndexHigh << 32) | info.nFileIndexLow);
  return w < 0 || w >= n ? -1 : w;
}

int
quad_close(int fd)
{
  if (fd >= 0 && fd <= 2) return 0;
  if (closesocket((SOCKET)(uintptr_t)(unsigned)fd) == 0) return 0;
  if (WSAGetLastError() != WSAENOTSOCK) return -1;
  return CloseHandle((HANDLE)(uintptr_t)(unsigned)fd) ? 0 : -1;
}

// Renames from to to, replacing whatever is there, as rename(2) does on
// Unix (Chez Scheme's rename-file, _wrename, will not): 0, or -1. A file
// replaced keeps what it was -- its permissions, attributes and creation
// time -- as an editor's save should leave them (ReplaceFileW).
int
quad_rename(const char* from, const char* to)
{
  wchar_t* wf = widen(from);
  wchar_t* wt = widen(to);
  int result = -1;
  if (wf && wt) {
    if (GetFileAttributesW(wt) != INVALID_FILE_ATTRIBUTES
        && ReplaceFileW(wt, wf, NULL, REPLACEFILE_IGNORE_MERGE_ERRORS, NULL, NULL))
      result = 0;
    else if (MoveFileExW(wf, wt, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      result = 0;
  }
  free(wf);
  free(wt);
  return result;
}

/* -------------------------------------------------------------------------- */
/* -- Detaching ------------------------------------------------------------- */

// Start a process to go on without the console, as a window does by default
// (main.sls): a new quad, with the same command line, no console, its
// standard streams on NUL, and the write end of a pipe to tell this one how
// opening its window went, which it finds in QUAD_DETACHED_FD. Returns the
// child's pid in the parent, 0 in the child, or -1; *fd is the socket
// each keeps for its end of the pipe (pumped, as a pipe is not a socket).
static int g_detached_fd = -1;

static void
take_detached_fd(void)
{
  const char* var = getenv("QUAD_DETACHED_FD");
  if (!var) return;
  char* end;
  unsigned long long v = strtoull(var, &end, 10);
  HANDLE h = (HANDLE)(uintptr_t)v;
  DWORD flags;
  if (*var && *end == '\0' && GetHandleInformation(h, &flags)) {
    SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
    SOCKET s = pump(h, 1);
    if (s != INVALID_SOCKET) g_detached_fd = (int)s;
  }
  // No further, to the programs the editor runs.
  _putenv_s("QUAD_DETACHED_FD", "");
}

int
quad_fork_detached(int* fd)
{
  if (g_detached_fd >= 0) {
    *fd = g_detached_fd;
    g_detached_fd = -1;
    return 0;
  }
  HANDLE r, w;
  if (!CreatePipe(&r, &w, NULL, 0)) return -1;
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit,
                           OPEN_EXISTING, 0, NULL);
  SetHandleInformation(w, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

  // The environment, naming the child's end of the pipe.
  wchar_t var[64];
  swprintf(var, 64, L"QUAD_DETACHED_FD=%llu", (unsigned long long)(uintptr_t)w);
  wchar_t* env = GetEnvironmentStringsW();
  size_t env_len = 0;
  while (env[env_len]) env_len += wcslen(env + env_len) + 1;
  wchar_t* block = malloc((env_len + wcslen(var) + 2) * sizeof(wchar_t));
  wchar_t* cmdline = _wcsdup(GetCommandLineW());
  wchar_t self[32768];
  DWORD self_len = GetModuleFileNameW(NULL, self, 32768);
  int pid = -1;
  LPPROC_THREAD_ATTRIBUTE_LIST attrs = NULL;
  if (!block || !cmdline || nul == INVALID_HANDLE_VALUE || self_len == 0 || self_len >= 32768) goto out;
  size_t at = 0;
  for (wchar_t* e = env; *e; e += wcslen(e) + 1) {
    if (_wcsnicmp(e, L"QUAD_DETACHED_FD=", 17) == 0) continue;
    size_t len = wcslen(e) + 1;
    memcpy(block + at, e, len * sizeof(wchar_t));
    at += len;
  }
  memcpy(block + at, var, (wcslen(var) + 1) * sizeof(wchar_t));
  at += wcslen(var) + 1;
  block[at] = L'\0';

  // Only the pipe's end and NUL are inherited, of all this process has.
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  attrs = malloc(size);
  if (!attrs || !InitializeProcThreadAttributeList(attrs, 1, 0, &size)) goto out;
  HANDLE inherited[2] = {w, nul};
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL,
                                 NULL))
    goto out;
  STARTUPINFOEXW si;
  memset(&si, 0, sizeof(si));
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = nul;
  si.StartupInfo.hStdOutput = nul;
  si.StartupInfo.hStdError = nul;
  si.lpAttributeList = attrs;
  PROCESS_INFORMATION pi;
  if (CreateProcessW(self, cmdline, NULL, NULL, TRUE,
                     DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT
                         | EXTENDED_STARTUPINFO_PRESENT,
                     block, NULL, &si.StartupInfo, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    pid = (int)pi.dwProcessId;
  }
out:
  if (attrs) {
    DeleteProcThreadAttributeList(attrs);
    free(attrs);
  }
  free(cmdline);
  free(block);
  FreeEnvironmentStringsW(env);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  CloseHandle(w);
  if (pid < 0) {
    CloseHandle(r);
    return -1;
  }
  SOCKET s = pump(r, 0);
  if (s == INVALID_SOCKET) return -1;
  *fd = (int)s;
  return pid;
}

const char*
quad_self_path(void)
{
  return g_self_path ? g_self_path : "";
}

// The machine's name, or "" if it has none.
const char*
quad_hostname(void)
{
  static char name[256];
  if (gethostname(name, sizeof(name)) != 0) name[0] = '\0';
  name[sizeof(name) - 1] = '\0';
  return name;
}

// Only macOS starts quad as an app (core/main.sls).
int
quad_launched_as_app(void)
{
  return 0;
}

/* -------------------------------------------------------------------------- */
/* -- Process --------------------------------------------------------------- */

void
os_restore_terminal(void)
{
  restore_at_exit();
}

int
os_detached(void)
{
  return g_detached_fd >= 0;
}

void
os_init(void)
{
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    fprintf(stderr, "quad: fatal: no Windows Sockets\n");
    exit(70);
  }
  wake_open();
  SetConsoleCtrlHandler(on_console_event, TRUE);
  take_detached_fd();
}

void
os_before_main_thread(void)
{
}

void
os_scheme_thread(void)
{
}

// As much stack as a Linux main thread has by default.
size_t
os_scheme_stack_size(void)
{
  return 8 << 20;
}
