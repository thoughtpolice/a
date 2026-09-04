// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define _GNU_SOURCE

#include "fozzie/runtime/protocol.h"
#include "fozzie/runtime/target.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern void __sanitizer_cov_8bit_counters_init(char* begin, char* end);
extern void __sanitizer_cov_pcs_init(const uintptr_t* begin, const uintptr_t* end);
extern void __sanitizer_cov_trace_cmp1(uint8_t arg1, uint8_t arg2);
extern void __sanitizer_cov_trace_const_cmp4(uint32_t arg1, uint32_t arg2);
extern void __sanitizer_cov_trace_switch(uint64_t value, uint64_t* cases);

static uint8_t test_counters[3];
static const uintptr_t test_pcs[6] = {
    0x1000, 0,
    0x2000, 0,
    0x3000, 0,
};
static int initialize_calls;
static const volatile void* last_unpoison_address;
static size_t last_unpoison_size;
static const volatile void* last_poison_address;
static size_t last_poison_size;

void __asan_unpoison_memory_region(const volatile void* address, size_t size) {
    last_unpoison_address = address;
    last_unpoison_size = size;
}

void __asan_poison_memory_region(const volatile void* address, size_t size) {
    last_poison_address = address;
    last_poison_size = size;
}

__attribute__((constructor)) static void register_test_instrumentation(void) {
    __sanitizer_cov_8bit_counters_init((char*)test_counters,
        (char*)test_counters + sizeof(test_counters));
    __sanitizer_cov_pcs_init(test_pcs, test_pcs + sizeof(test_pcs) / sizeof(test_pcs[0]));
}

int LLVMFuzzerInitialize(int* argc, char*** argv) {
    (void)argc;
    (void)argv;
    ++initialize_calls;
    return 0;
}

int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (initialize_calls != 1 || size != 1 || last_unpoison_address != data ||
        last_unpoison_size != size || last_poison_address != data + size ||
        last_poison_size != 64 - size) {
        return 99;
    }
    if (data[0] == 1) {
        test_counters[0] = 1;
        test_counters[1] = 3;
        test_counters[2] = 8;
        __sanitizer_cov_trace_cmp1(0x12, 0x34);
        __sanitizer_cov_trace_const_cmp4(UINT32_C(0xfeedface), data[0]);
        uint64_t cases[] = {3, 8, 1, 2, 3};
        __sanitizer_cov_trace_switch(data[0], cases);
        return 0;
    }
    if (data[0] == 2) {
        test_counters[0] = 255;
        return 0;
    }
    test_counters[0] = 1;
    return 17;
}

static void fail(const char* message) {
    fprintf(stderr, "runtime-test: %s\n", message);
    exit(1);
}

static void check(int condition, const char* message) {
    if (!condition) {
        fail(message);
    }
}

static void write_full(int fd, const void* data, size_t size) {
    const uint8_t* cursor = data;
    while (size != 0) {
        ssize_t amount = write(fd, cursor, size);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        check(amount > 0, "write failed");
        cursor += (size_t)amount;
        size -= (size_t)amount;
    }
}

static void read_full(int fd, void* data, size_t size) {
    uint8_t* cursor = data;
    while (size != 0) {
        ssize_t amount = read(fd, cursor, size);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        check(amount > 0, "read failed");
        cursor += (size_t)amount;
        size -= (size_t)amount;
    }
}

static void initialize_header(struct fozzie_shm_header* header) {
    static const uint8_t magic[8] = FOZZIE_SHM_MAGIC_INIT;
    memset(header, 0, sizeof(*header));
    memcpy(header->magic, magic, sizeof(magic));
    fozzie_store_le32(header->version_le, FOZZIE_SHM_LAYOUT_VERSION);
    fozzie_store_le32(header->header_size_le, FOZZIE_SHM_HEADER_SIZE);
    fozzie_store_le64(header->total_size_le, 448);
    fozzie_store_le64(header->input_offset_le, 128);
    fozzie_store_le64(header->input_capacity_le, 64);
    fozzie_store_le64(header->feature_offset_le, 192);
    fozzie_store_le32(header->feature_capacity_le, 16);
    fozzie_store_le32(header->feature_entry_size_le, FOZZIE_FEATURE_ENTRY_SIZE);
    fozzie_store_le64(header->cmp_offset_le, 320);
    fozzie_store_le32(header->cmp_capacity_le, 4);
    fozzie_store_le32(header->cmp_entry_size_le, FOZZIE_CMP_ENTRY_SIZE);
}

static int make_listener(const char* path) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    check(fd >= 0, "socket failed");
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    check(strlen(path) < sizeof(address.sun_path), "socket path too long");
    strcpy(address.sun_path, path);
    check(bind(fd, (const struct sockaddr*)&address,
              (socklen_t)(offsetof(struct sockaddr_un, sun_path) + strlen(path) + 1)) == 0,
        "bind failed");
    check(listen(fd, 1) == 0, "listen failed");
    return fd;
}

static struct fozzie_done_frame run_one(
    int socket_fd, uint8_t* mapping, uint64_t run_id, uint8_t input) {
    mapping[128] = input;
    struct fozzie_run_frame run;
    memset(&run, 0, sizeof(run));
    fozzie_init_frame_header(&run.header, sizeof(run), FOZZIE_FRAME_RUN);
    fozzie_store_le64(run.run_id_le, run_id);
    fozzie_store_le64(run.input_size_le, 1);
    write_full(socket_fd, &run, sizeof(run));

    struct fozzie_done_frame done;
    read_full(socket_fd, &done, sizeof(done));
    check(fozzie_load_le32(done.header.size_le) == sizeof(done), "bad Done frame size");
    check(fozzie_load_le16(done.header.version_le) == FOZZIE_PROTOCOL_VERSION,
        "bad Done protocol version");
    check(done.header.type == FOZZIE_FRAME_DONE, "bad Done frame type");
    check(fozzie_load_le64(done.run_id_le) == run_id, "bad Done run id");
    return done;
}

int main(void) {
    char directory[] = "/tmp/fozzie-runtime-test.XXXXXX";
    check(mkdtemp(directory) != NULL, "mkdtemp failed");

    char shm_path[256];
    char socket_path[256];
    check(snprintf(shm_path, sizeof(shm_path), "%s/shm", directory) > 0, "shm path failed");
    check(snprintf(socket_path, sizeof(socket_path), "%s/socket", directory) > 0,
        "socket path failed");

    int shm_fd = open(shm_path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    check(shm_fd >= 0, "open shm failed");
    check(ftruncate(shm_fd, 448) == 0, "ftruncate failed");
    uint8_t* mapping = mmap(NULL, 448, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    check(mapping != MAP_FAILED, "mmap failed");
    initialize_header((struct fozzie_shm_header*)mapping);

    int listener = make_listener(socket_path);
    pid_t child = fork();
    check(child >= 0, "fork failed");
    if (child == 0) {
        close(listener);
        if (setenv("FOZZIE_SHM_PATH", shm_path, 1) != 0 ||
            setenv("FOZZIE_SOCKET_PATH", socket_path, 1) != 0) {
            _exit(120);
        }
        _exit(fozzie_target_main(0, NULL));
    }

    int control = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    check(control >= 0, "accept failed");
    struct fozzie_hello_frame hello;
    read_full(control, &hello, sizeof(hello));
    check(fozzie_load_le32(hello.header.size_le) == sizeof(hello), "bad Hello frame size");
    check(fozzie_load_le16(hello.header.version_le) == FOZZIE_PROTOCOL_VERSION,
        "bad Hello protocol version");
    check(hello.header.type == FOZZIE_FRAME_HELLO, "bad Hello frame type");
    check(fozzie_load_le32(hello.layout_version_le) == FOZZIE_SHM_LAYOUT_VERSION,
        "bad Hello layout version");
    check(fozzie_load_le64(hello.capabilities_le) ==
            (FOZZIE_CAP_INLINE_8BIT_COUNTERS | FOZZIE_CAP_PC_TABLE | FOZZIE_CAP_TRACE_CMP),
        "bad Hello capabilities");
    check(fozzie_load_le64(hello.counter_count_le) == 3, "bad registered counter count");

    struct fozzie_done_frame first = run_one(control, mapping, 101, 1);
    check(fozzie_load_le32(first.status_le) == FOZZIE_DONE_OK, "first run failed");
    check(fozzie_load_le32(first.feature_count_le) == 3, "first feature count wrong");
    check(fozzie_load_le32(first.cmp_count_le) == 4, "comparison bound not enforced");
    check((fozzie_load_le32(first.done_flags_le) & FOZZIE_DONE_COMPARISONS_TRUNCATED) != 0,
        "comparison truncation not reported");

    struct fozzie_feature_entry* features = (struct fozzie_feature_entry*)(mapping + 192);
    check(fozzie_load_le64(features[0].feature_id_le) == 0, "count=1 bucket wrong");
    check(fozzie_load_le64(features[1].feature_id_le) == 10, "count=3 bucket wrong");
    check(fozzie_load_le64(features[2].feature_id_le) == 20, "count=8 bucket wrong");

    struct fozzie_cmp_entry* comparisons = (struct fozzie_cmp_entry*)(mapping + 320);
    check(comparisons[0].width == 1 && comparisons[0].kind == FOZZIE_CMP_PLAIN,
        "plain cmp entry wrong");
    check(fozzie_load_le64(comparisons[0].arg1_le) == 0x12 &&
            fozzie_load_le64(comparisons[0].arg2_le) == 0x34,
        "plain cmp values wrong");
    check(comparisons[1].width == 4 && comparisons[1].kind == FOZZIE_CMP_CONST,
        "const cmp entry wrong");
    check(comparisons[2].kind == FOZZIE_CMP_SWITCH, "switch cmp entry wrong");

    struct fozzie_done_frame second = run_one(control, mapping, 102, 2);
    check(fozzie_load_le32(second.status_le) == FOZZIE_DONE_OK, "second run failed");
    check(fozzie_load_le32(second.feature_count_le) == 1, "counter reset failed");
    check(fozzie_load_le32(second.cmp_count_le) == 0, "comparison reset failed");
    check(fozzie_load_le64(features[0].feature_id_le) == 7, "count=255 bucket wrong");

    struct fozzie_done_frame third = run_one(control, mapping, 103, 3);
    check(fozzie_load_le32(third.status_le) == FOZZIE_DONE_HARNESS_NONZERO,
        "nonzero harness status not distinguished");
    check((int32_t)fozzie_load_le32(third.harness_return_le) == 17,
        "nonzero harness return lost");

    struct fozzie_stop_frame stop;
    memset(&stop, 0, sizeof(stop));
    fozzie_init_frame_header(&stop.header, sizeof(stop), FOZZIE_FRAME_STOP);
    write_full(control, &stop, sizeof(stop));
    close(control);

    int child_status;
    check(waitpid(child, &child_status, 0) == child, "waitpid failed");
    check(WIFEXITED(child_status) && WEXITSTATUS(child_status) == FOZZIE_TARGET_EXIT_OK,
        "target did not stop cleanly");

    close(listener);
    munmap(mapping, 448);
    close(shm_fd);
    unlink(socket_path);
    unlink(shm_path);
    rmdir(directory);
    return 0;
}
