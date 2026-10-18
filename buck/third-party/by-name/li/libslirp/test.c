/*
 * SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0
 */

/* Creates and tears down a stack with QEMU's default -netdev user network,
 * and checks the library's version agrees with its header. */

#include <arpa/inet.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

#include <glib.h>
#include <libslirp.h>

static slirp_ssize_t send_packet(const void *buf, size_t len, void *opaque)
{
    return len;
}

static void guest_error(const char *msg, void *opaque)
{
    fprintf(stderr, "guest error: %s\n", msg);
}

static int64_t clock_get_ns(void *opaque)
{
    return 0;
}

static void *timer_new_opaque(SlirpTimerId id, void *cb_opaque, void *opaque)
{
    return NULL;
}

static void timer_free(void *timer, void *opaque)
{
}

static void timer_mod(void *timer, int64_t expire_time, void *opaque)
{
}

static void register_poll_socket(slirp_os_socket fd, void *opaque)
{
}

static void unregister_poll_socket(slirp_os_socket fd, void *opaque)
{
}

static void notify(void *opaque)
{
}

static const SlirpCb callbacks = {
    .send_packet = send_packet,
    .guest_error = guest_error,
    .clock_get_ns = clock_get_ns,
    .timer_free = timer_free,
    .timer_mod = timer_mod,
    .register_poll_socket = register_poll_socket,
    .unregister_poll_socket = unregister_poll_socket,
    .notify = notify,
    .timer_new_opaque = timer_new_opaque,
};

int main(void)
{
    assert(strcmp(slirp_version_string(), SLIRP_VERSION_STRING) == 0);
    assert(SLIRP_CHECK_VERSION(4, 7, 0));

    SlirpConfig config = {
        .version = SLIRP_CONFIG_VERSION_MAX,
        .in_enabled = true,
        .vnetwork.s_addr = htonl(0x0a000200),
        .vnetmask.s_addr = htonl(0xffffff00),
        .vhost.s_addr = htonl(0x0a000202),
        .vdhcp_start.s_addr = htonl(0x0a00020f),
        .vnameserver.s_addr = htonl(0x0a000203),
        .vhostname = "buck",
    };
    Slirp *slirp = slirp_new(&config, &callbacks, NULL);
    assert(slirp != NULL);

    char *info = slirp_connection_info(slirp);
    assert(info != NULL);
    g_free(info);

    slirp_cleanup(slirp);
    printf("libslirp %s ok\n", slirp_version_string());
    return 0;
}
