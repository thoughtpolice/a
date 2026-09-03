// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#define _GNU_SOURCE

#include "fozzie/runtime/protocol.h"
#include "fozzie/runtime/target.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#if defined(__clang__) || defined(__GNUC__)
#define FOZZIE_NOCOV __attribute__((no_sanitize("coverage")))
#define FOZZIE_WEAK __attribute__((weak))
#else
#define FOZZIE_NOCOV
#define FOZZIE_WEAK
#endif

#define FOZZIE_MAX_COUNTER_SPANS 512U
#define FOZZIE_MAX_PC_SPANS 512U
#define FOZZIE_ASAN_GRANULARITY 8U

struct counter_span {
    uint8_t* begin;
    uint8_t* end;
    size_t size;
    uint64_t base;
};

struct pc_span {
    const uintptr_t* begin;
    const uintptr_t* end;
};

struct runtime_state {
    int shm_fd;
    int socket_fd;
    uint8_t* mapping;
    size_t mapping_size;
    uint8_t* shared_input;
    uint8_t* target_input;
    uint8_t* input_arena;
    size_t input_arena_size;
    size_t input_prefix_size;
    size_t input_slot_size;
    uint64_t input_capacity;
    uint8_t* features;
    uint32_t feature_capacity;
    uint8_t* comparisons;
    uint32_t comparison_capacity;
};

static struct counter_span counter_spans[FOZZIE_MAX_COUNTER_SPANS];
static struct pc_span pc_spans[FOZZIE_MAX_PC_SPANS];
static size_t counter_span_count;
static size_t pc_span_count;
static uint64_t counter_count;
static uint64_t pc_count;
static bool registration_error;
static bool registration_closed;

static struct runtime_state state = {
    .shm_fd = -1,
    .socket_fd = -1,
};
static _Atomic uint32_t comparison_count;
static _Atomic bool comparisons_truncated;
static _Atomic bool collecting;
static _Atomic bool target_started;

/* Present only in address-sanitized final binaries. */
FOZZIE_OPTIONAL void __asan_poison_memory_region(const volatile void* address, size_t size);
FOZZIE_OPTIONAL void __asan_unpoison_memory_region(const volatile void* address, size_t size);

FOZZIE_NOCOV static bool bytes_are_zero(const uint8_t* bytes, size_t size) {
    for (size_t index = 0; index < size; ++index) {
        if (bytes[index] != 0) {
            return false;
        }
    }
    return true;
}

FOZZIE_NOCOV static bool range_valid(uint64_t offset, uint64_t count, uint64_t stride,
    uint64_t total_size) {
    if (offset < FOZZIE_SHM_HEADER_SIZE || (offset & UINT64_C(7)) != 0 || stride == 0) {
        return false;
    }
    if (count > (UINT64_MAX - offset) / stride) {
        return false;
    }
    return offset + count * stride <= total_size;
}

FOZZIE_NOCOV static bool ranges_overlap(
    uint64_t a_offset, uint64_t a_size, uint64_t b_offset, uint64_t b_size) {
    return a_offset < b_offset + b_size && b_offset < a_offset + a_size;
}

FOZZIE_NOCOV static int decode_layout(
    const struct fozzie_shm_header* header, uint64_t file_size, struct runtime_state* result) {
    static const uint8_t magic[8] = FOZZIE_SHM_MAGIC_INIT;
    if (memcmp(header->magic, magic, sizeof(magic)) != 0 ||
        fozzie_load_le32(header->version_le) != FOZZIE_SHM_LAYOUT_VERSION ||
        fozzie_load_le32(header->header_size_le) != FOZZIE_SHM_HEADER_SIZE) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }

    const uint64_t total_size = fozzie_load_le64(header->total_size_le);
    const uint64_t input_offset = fozzie_load_le64(header->input_offset_le);
    const uint64_t input_capacity = fozzie_load_le64(header->input_capacity_le);
    const uint64_t feature_offset = fozzie_load_le64(header->feature_offset_le);
    const uint64_t feature_capacity = fozzie_load_le32(header->feature_capacity_le);
    const uint64_t feature_stride = fozzie_load_le32(header->feature_entry_size_le);
    const uint64_t cmp_offset = fozzie_load_le64(header->cmp_offset_le);
    const uint64_t cmp_capacity = fozzie_load_le32(header->cmp_capacity_le);
    const uint64_t cmp_stride = fozzie_load_le32(header->cmp_entry_size_le);

    if (total_size < FOZZIE_SHM_HEADER_SIZE || total_size > file_size || total_size > SIZE_MAX ||
        input_capacity == 0 || feature_stride != FOZZIE_FEATURE_ENTRY_SIZE ||
        cmp_stride != FOZZIE_CMP_ENTRY_SIZE || fozzie_load_le64(header->flags_le) != 0 ||
        !bytes_are_zero(header->reserved, sizeof(header->reserved)) ||
        !range_valid(input_offset, input_capacity, 1, total_size) ||
        !range_valid(feature_offset, feature_capacity, feature_stride, total_size) ||
        !range_valid(cmp_offset, cmp_capacity, cmp_stride, total_size)) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }

    const uint64_t input_size = input_capacity;
    const uint64_t feature_size = feature_capacity * feature_stride;
    const uint64_t cmp_size = cmp_capacity * cmp_stride;
    if (ranges_overlap(input_offset, input_size, feature_offset, feature_size) ||
        ranges_overlap(input_offset, input_size, cmp_offset, cmp_size) ||
        ranges_overlap(feature_offset, feature_size, cmp_offset, cmp_size)) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }

    result->mapping_size = (size_t)total_size;
    result->input_capacity = input_capacity;
    result->feature_capacity = (uint32_t)feature_capacity;
    result->comparison_capacity = (uint32_t)cmp_capacity;
    return FOZZIE_TARGET_EXIT_OK;
}

FOZZIE_NOCOV static bool pread_full(int fd, void* data, size_t size, off_t offset) {
    uint8_t* cursor = data;
    while (size != 0) {
        ssize_t amount = pread(fd, cursor, size, offset);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        if (amount <= 0) {
            return false;
        }
        cursor += (size_t)amount;
        offset += amount;
        size -= (size_t)amount;
    }
    return true;
}

FOZZIE_NOCOV static bool send_full(int fd, const void* data, size_t size) {
    const uint8_t* cursor = data;
    while (size != 0) {
        ssize_t amount = send(fd, cursor, size, MSG_NOSIGNAL);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        if (amount <= 0) {
            return false;
        }
        cursor += (size_t)amount;
        size -= (size_t)amount;
    }
    return true;
}

FOZZIE_NOCOV static bool recv_full(int fd, void* data, size_t size) {
    uint8_t* cursor = data;
    while (size != 0) {
        ssize_t amount = recv(fd, cursor, size, 0);
        if (amount < 0 && errno == EINTR) {
            continue;
        }
        if (amount <= 0) {
            return false;
        }
        cursor += (size_t)amount;
        size -= (size_t)amount;
    }
    return true;
}

FOZZIE_NOCOV static int open_shared_memory(const char* path) {
    struct fozzie_shm_header header;
    struct stat stat_buffer;

    state.shm_fd = open(path, O_RDWR | O_CLOEXEC);
    if (state.shm_fd < 0 || fstat(state.shm_fd, &stat_buffer) != 0 || stat_buffer.st_size < 0 ||
        !pread_full(state.shm_fd, &header, sizeof(header), 0)) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }

    int status = decode_layout(&header, (uint64_t)stat_buffer.st_size, &state);
    if (status != FOZZIE_TARGET_EXIT_OK) {
        return status;
    }

    state.mapping = mmap(NULL, state.mapping_size, PROT_READ | PROT_WRITE, MAP_SHARED, state.shm_fd, 0);
    if (state.mapping == MAP_FAILED) {
        state.mapping = NULL;
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }

    state.shared_input = state.mapping + fozzie_load_le64(header.input_offset_le);
    state.features = state.mapping + fozzie_load_le64(header.feature_offset_le);
    state.comparisons = state.mapping + fozzie_load_le64(header.cmp_offset_le);
    return FOZZIE_TARGET_EXIT_OK;
}

FOZZIE_NOCOV static int create_input_arena(void) {
    long page_size_result = sysconf(_SC_PAGESIZE);
    if (page_size_result <= 0) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }
    size_t page_size = (size_t)page_size_result;
    size_t capacity = (size_t)state.input_capacity;
    if (page_size < FOZZIE_ASAN_GRANULARITY ||
        page_size % FOZZIE_ASAN_GRANULARITY != 0 || page_size > SIZE_MAX / 2 ||
        capacity > SIZE_MAX - (page_size - 1)) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }
    size_t rounded_capacity = ((capacity + page_size - 1) / page_size) * page_size;
    if (rounded_capacity > SIZE_MAX - 2 * page_size) {
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }
    state.input_arena_size = rounded_capacity + 2 * page_size;
    state.input_arena = mmap(NULL, state.input_arena_size, PROT_NONE,
        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (state.input_arena == MAP_FAILED) {
        state.input_arena = NULL;
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }
    uint8_t* writable = state.input_arena + page_size;
    if (mprotect(writable, rounded_capacity, PROT_READ | PROT_WRITE) != 0) {
        munmap(state.input_arena, state.input_arena_size);
        state.input_arena = NULL;
        return FOZZIE_TARGET_EXIT_SHARED_MEMORY;
    }
    state.input_slot_size =
        (capacity + FOZZIE_ASAN_GRANULARITY - 1U) &
        ~((size_t)FOZZIE_ASAN_GRANULARITY - 1U);
    state.input_prefix_size = rounded_capacity - state.input_slot_size;
    state.target_input = writable + state.input_prefix_size;
    return FOZZIE_TARGET_EXIT_OK;
}

FOZZIE_NOCOV static int connect_control_socket(const char* path) {
    struct sockaddr_un address;
    size_t path_size = strlen(path);
    if (path_size == 0 || path_size >= sizeof(address.sun_path)) {
        return FOZZIE_TARGET_EXIT_SOCKET;
    }

    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, path, path_size + 1);

    state.socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (state.socket_fd < 0 ||
        connect(state.socket_fd, (const struct sockaddr*)&address,
            (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_size + 1)) != 0) {
        return FOZZIE_TARGET_EXIT_SOCKET;
    }
    return FOZZIE_TARGET_EXIT_OK;
}

FOZZIE_NOCOV static void cleanup_runtime(void) {
    atomic_store_explicit(&collecting, false, memory_order_release);
    if (state.socket_fd >= 0) {
        close(state.socket_fd);
        state.socket_fd = -1;
    }
    if (state.mapping != NULL) {
        munmap(state.mapping, state.mapping_size);
        state.mapping = NULL;
    }
    if (state.input_arena != NULL) {
        munmap(state.input_arena, state.input_arena_size);
        state.input_arena = NULL;
        state.target_input = NULL;
    }
    if (state.shm_fd >= 0) {
        close(state.shm_fd);
        state.shm_fd = -1;
    }
}

FOZZIE_NOCOV static int initialize_runtime(void) {
    const char* shm_path = getenv("FOZZIE_SHM_PATH");
    const char* socket_path = getenv("FOZZIE_SOCKET_PATH");
    if (shm_path == NULL || socket_path == NULL || shm_path[0] == '\0' || socket_path[0] == '\0') {
        return FOZZIE_TARGET_EXIT_CONFIGURATION;
    }
    if (registration_error) {
        return FOZZIE_TARGET_EXIT_INSTRUMENTATION;
    }

    registration_closed = true;
    int status = open_shared_memory(shm_path);
    if (status == FOZZIE_TARGET_EXIT_OK) {
        status = create_input_arena();
    }
    if (status == FOZZIE_TARGET_EXIT_OK) {
        status = connect_control_socket(socket_path);
    }
    if (status != FOZZIE_TARGET_EXIT_OK) {
        cleanup_runtime();
    }
    return status;
}

FOZZIE_NOCOV static bool send_hello(void) {
    struct fozzie_hello_frame hello;
    memset(&hello, 0, sizeof(hello));
    fozzie_init_frame_header(&hello.header, sizeof(hello), FOZZIE_FRAME_HELLO);
    fozzie_store_le32(hello.layout_version_le, FOZZIE_SHM_LAYOUT_VERSION);
    uint64_t capabilities = FOZZIE_CAP_INLINE_8BIT_COUNTERS | FOZZIE_CAP_TRACE_CMP;
    if (pc_count == counter_count) {
        capabilities |= FOZZIE_CAP_PC_TABLE;
    }
    fozzie_store_le64(hello.capabilities_le, capabilities);
    fozzie_store_le64(hello.counter_count_le, counter_count);
    return send_full(state.socket_fd, &hello, sizeof(hello));
}

FOZZIE_NOCOV static void reset_observations(void) {
    for (size_t span_index = 0; span_index < counter_span_count; ++span_index) {
        struct counter_span* span = &counter_spans[span_index];
        memset(span->begin, 0, span->size);
    }
    atomic_store_explicit(&comparison_count, 0, memory_order_relaxed);
    atomic_store_explicit(&comparisons_truncated, false, memory_order_relaxed);
}

FOZZIE_NOCOV static void configure_input_bounds(size_t input_size) {
    if (__asan_poison_memory_region == NULL || __asan_unpoison_memory_region == NULL) {
        return;
    }
    if (state.input_prefix_size != 0) {
        __asan_poison_memory_region(
            state.target_input - state.input_prefix_size, state.input_prefix_size);
    }
    __asan_unpoison_memory_region(state.target_input, input_size);
    __asan_poison_memory_region(
        state.target_input + input_size, state.input_slot_size - input_size);
}

FOZZIE_NOCOV static uint8_t hit_bucket(uint8_t count) {
    if (count <= 3) {
        return (uint8_t)(count - 1);
    }
    if (count <= 7) {
        return 3;
    }
    if (count <= 15) {
        return 4;
    }
    if (count <= 31) {
        return 5;
    }
    if (count <= 127) {
        return 6;
    }
    return 7;
}

FOZZIE_NOCOV static uint32_t scan_features(uint32_t* done_flags) {
    uint32_t written = 0;
    for (size_t span_index = 0; span_index < counter_span_count; ++span_index) {
        struct counter_span* span = &counter_spans[span_index];
        for (size_t counter_index = 0; counter_index < span->size; ++counter_index) {
            uint8_t* counter = span->begin + counter_index;
            uint8_t count = *counter;
            *counter = 0;
            if (count == 0) {
                continue;
            }

            uint64_t dense_id = span->base + (uint64_t)counter_index;
            uint64_t feature_id = (dense_id << 3) | hit_bucket(count);
            if (written < state.feature_capacity) {
                struct fozzie_feature_entry* entry = (struct fozzie_feature_entry*)(
                    state.features + (size_t)written * FOZZIE_FEATURE_ENTRY_SIZE);
                fozzie_store_le64(entry->feature_id_le, feature_id);
                ++written;
            } else {
                *done_flags |= FOZZIE_DONE_FEATURES_TRUNCATED;
            }
        }
    }
    return written;
}

FOZZIE_NOCOV static bool send_done(
    uint64_t run_id, int harness_return, uint32_t feature_count, uint32_t done_flags) {
    struct fozzie_done_frame done;
    memset(&done, 0, sizeof(done));
    fozzie_init_frame_header(&done.header, sizeof(done), FOZZIE_FRAME_DONE);
    fozzie_store_le64(done.run_id_le, run_id);
    fozzie_store_le32(done.status_le,
        harness_return == 0 ? FOZZIE_DONE_OK : FOZZIE_DONE_HARNESS_NONZERO);
    fozzie_store_le32(done.harness_return_le, (uint32_t)(int32_t)harness_return);
    fozzie_store_le32(done.feature_count_le, feature_count);
    uint32_t cmp_count = atomic_load_explicit(&comparison_count, memory_order_relaxed);
    fozzie_store_le32(done.cmp_count_le, cmp_count);
    if (atomic_load_explicit(&comparisons_truncated, memory_order_relaxed)) {
        done_flags |= FOZZIE_DONE_COMPARISONS_TRUNCATED;
    }
    fozzie_store_le32(done.done_flags_le, done_flags);
    atomic_thread_fence(memory_order_release);
    return send_full(state.socket_fd, &done, sizeof(done));
}

FOZZIE_NOCOV static int run_loop(void) {
    union {
        struct fozzie_frame_header header;
        struct fozzie_run_frame run;
        struct fozzie_stop_frame stop;
    } command;

    for (;;) {
        memset(&command, 0, sizeof(command));
        if (!recv_full(state.socket_fd, &command.header, sizeof(command.header))) {
            return FOZZIE_TARGET_EXIT_PROTOCOL;
        }
        uint32_t size = fozzie_load_le32(command.header.size_le);
        if (fozzie_load_le16(command.header.version_le) != FOZZIE_PROTOCOL_VERSION ||
            command.header.flags != 0) {
            return FOZZIE_TARGET_EXIT_PROTOCOL;
        }

        if (command.header.type == FOZZIE_FRAME_STOP && size == FOZZIE_STOP_FRAME_SIZE) {
            if (!recv_full(state.socket_fd, (uint8_t*)&command + sizeof(command.header),
                    size - sizeof(command.header))) {
                return FOZZIE_TARGET_EXIT_PROTOCOL;
            }
            if (!bytes_are_zero(command.stop.reserved_le, sizeof(command.stop.reserved_le))) {
                return FOZZIE_TARGET_EXIT_PROTOCOL;
            }
            return FOZZIE_TARGET_EXIT_OK;
        }
        if (command.header.type != FOZZIE_FRAME_RUN || size != FOZZIE_RUN_FRAME_SIZE ||
            !recv_full(state.socket_fd, (uint8_t*)&command + sizeof(command.header),
                size - sizeof(command.header))) {
            return FOZZIE_TARGET_EXIT_PROTOCOL;
        }

        uint64_t run_id = fozzie_load_le64(command.run.run_id_le);
        uint64_t input_size = fozzie_load_le64(command.run.input_size_le);
        if (input_size > state.input_capacity || input_size > SIZE_MAX) {
            return FOZZIE_TARGET_EXIT_PROTOCOL;
        }

        reset_observations();
        configure_input_bounds((size_t)input_size);
        memcpy(state.target_input, state.shared_input, (size_t)input_size);
        atomic_store_explicit(&collecting, true, memory_order_release);
        int harness_return = LLVMFuzzerTestOneInput(state.target_input, (size_t)input_size);
        atomic_store_explicit(&collecting, false, memory_order_release);

        uint32_t done_flags = 0;
        uint32_t feature_count = scan_features(&done_flags);
        if (!send_done(run_id, harness_return, feature_count, done_flags)) {
            return FOZZIE_TARGET_EXIT_PROTOCOL;
        }
    }
}

FOZZIE_NOCOV FOZZIE_EXPORT int fozzie_target_main(int argc, char** argv) {
    if (atomic_exchange_explicit(&target_started, true, memory_order_acq_rel)) {
        return FOZZIE_TARGET_EXIT_CONFIGURATION;
    }
    if (LLVMFuzzerInitialize != NULL) {
        (void)LLVMFuzzerInitialize(&argc, &argv);
    }

    int status = initialize_runtime();
    if (status == FOZZIE_TARGET_EXIT_OK && !send_hello()) {
        status = FOZZIE_TARGET_EXIT_PROTOCOL;
    }
    if (status == FOZZIE_TARGET_EXIT_OK) {
        status = run_loop();
    }
    cleanup_runtime();
    return status;
}

FOZZIE_NOCOV FOZZIE_WEAK int main(int argc, char** argv) {
    return fozzie_target_main(argc, argv);
}

FOZZIE_NOCOV void __sanitizer_cov_8bit_counters_init(char* begin, char* end) {
    if (begin == end || registration_closed) {
        return;
    }
    for (size_t index = 0; index < counter_span_count; ++index) {
        if (counter_spans[index].begin == (uint8_t*)begin && counter_spans[index].end == (uint8_t*)end) {
            return;
        }
    }

    const uintptr_t begin_address = (uintptr_t)begin;
    const uintptr_t end_address = (uintptr_t)end;
    const uint64_t max_counter_count = UINT64_MAX >> 3;
    if (begin == NULL || end == NULL || end_address < begin_address ||
        counter_span_count == FOZZIE_MAX_COUNTER_SPANS) {
        registration_error = true;
        return;
    }
    const uintptr_t span_bytes = end_address - begin_address;
    if (span_bytes > SIZE_MAX || span_bytes > UINT64_MAX) {
        registration_error = true;
        return;
    }
    const uint64_t span_size = (uint64_t)span_bytes;
    if (span_size > max_counter_count || counter_count > max_counter_count - span_size) {
        registration_error = true;
        return;
    }
    counter_spans[counter_span_count++] = (struct counter_span){
        .begin = (uint8_t*)begin,
        .end = (uint8_t*)end,
        .size = (size_t)span_bytes,
        .base = counter_count,
    };
    counter_count += span_size;
}

FOZZIE_NOCOV void __sanitizer_cov_pcs_init(const uintptr_t* begin, const uintptr_t* end) {
    if (begin == end || registration_closed) {
        return;
    }
    for (size_t index = 0; index < pc_span_count; ++index) {
        if (pc_spans[index].begin == begin && pc_spans[index].end == end) {
            return;
        }
    }

    const uintptr_t begin_address = (uintptr_t)begin;
    const uintptr_t end_address = (uintptr_t)end;
    const uintptr_t alignment = (uintptr_t)_Alignof(uintptr_t);
    const uintptr_t entry_size = (uintptr_t)2 * (uintptr_t)sizeof(uintptr_t);
    if (begin == NULL || end == NULL || end_address < begin_address ||
        begin_address % alignment != 0 || end_address % alignment != 0 ||
        pc_span_count == FOZZIE_MAX_PC_SPANS) {
        registration_error = true;
        return;
    }
    const uintptr_t span_bytes = end_address - begin_address;
    if (span_bytes % entry_size != 0) {
        registration_error = true;
        return;
    }
    const uintptr_t entry_count_raw = span_bytes / entry_size;
    if (entry_count_raw > UINT64_MAX) {
        registration_error = true;
        return;
    }
    const uint64_t entry_count = (uint64_t)entry_count_raw;
    if (pc_count > UINT64_MAX - entry_count) {
        registration_error = true;
        return;
    }
    pc_spans[pc_span_count++] = (struct pc_span){
        .begin = begin,
        .end = end,
    };
    pc_count += entry_count;
}

FOZZIE_NOCOV static void record_comparison(
    uint64_t arg1, uint64_t arg2, uint8_t width, uint8_t kind, uintptr_t pc) {
    if (!atomic_load_explicit(&collecting, memory_order_acquire)) {
        return;
    }

    uint32_t index = atomic_load_explicit(&comparison_count, memory_order_relaxed);
    for (;;) {
        if (index >= state.comparison_capacity) {
            atomic_store_explicit(&comparisons_truncated, true, memory_order_relaxed);
            return;
        }
        if (atomic_compare_exchange_weak_explicit(&comparison_count, &index, index + 1,
                memory_order_relaxed, memory_order_relaxed)) {
            break;
        }
    }

    struct fozzie_cmp_entry* entry = (struct fozzie_cmp_entry*)(
        state.comparisons + (size_t)index * FOZZIE_CMP_ENTRY_SIZE);
    fozzie_store_le64(entry->pc_le, (uint64_t)pc);
    fozzie_store_le64(entry->arg1_le, arg1);
    fozzie_store_le64(entry->arg2_le, arg2);
    fozzie_store_le32(entry->sequence_le, index);
    entry->width = width;
    entry->kind = kind;
    entry->reserved[0] = 0;
    entry->reserved[1] = 0;
}

#define FOZZIE_DEFINE_CMP(width, type)                                                               \
    FOZZIE_NOCOV void __sanitizer_cov_trace_cmp##width(type arg1, type arg2) {                        \
        record_comparison(arg1, arg2, sizeof(type), FOZZIE_CMP_PLAIN,                               \
            (uintptr_t)__builtin_return_address(0));                                                 \
    }                                                                                                \
    FOZZIE_NOCOV void __sanitizer_cov_trace_const_cmp##width(type arg1, type arg2) {                  \
        record_comparison(arg1, arg2, sizeof(type), FOZZIE_CMP_CONST,                               \
            (uintptr_t)__builtin_return_address(0));                                                 \
    }

FOZZIE_DEFINE_CMP(1, uint8_t)
FOZZIE_DEFINE_CMP(2, uint16_t)
FOZZIE_DEFINE_CMP(4, uint32_t)
FOZZIE_DEFINE_CMP(8, uint64_t)

FOZZIE_NOCOV void __sanitizer_cov_trace_switch(uint64_t value, uint64_t* cases) {
    uint64_t case_count = cases[0];
    uint64_t bits = cases[1];
    uint8_t width = bits == 0 ? 1 : (uint8_t)((bits + 7) / 8);
    if (width > 8) {
        width = 8;
    }
    for (uint64_t index = 0; index < case_count; ++index) {
        if (atomic_load_explicit(&comparison_count, memory_order_relaxed) >=
            state.comparison_capacity) {
            atomic_store_explicit(&comparisons_truncated, true, memory_order_relaxed);
            return;
        }
        record_comparison(value, cases[index + 2], width, FOZZIE_CMP_SWITCH,
            (uintptr_t)__builtin_return_address(0));
    }
}
