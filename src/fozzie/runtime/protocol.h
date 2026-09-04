// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#ifndef FOZZIE_RUNTIME_PROTOCOL_H
#define FOZZIE_RUNTIME_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#if defined(__cplusplus)
extern "C" {
#endif

#define FOZZIE_PROTOCOL_VERSION UINT16_C(1)
#define FOZZIE_SHM_LAYOUT_VERSION UINT32_C(1)

#define FOZZIE_SHM_HEADER_SIZE UINT32_C(128)
#define FOZZIE_FEATURE_ENTRY_SIZE UINT32_C(8)
#define FOZZIE_CMP_ENTRY_SIZE UINT32_C(32)

#define FOZZIE_FRAME_HEADER_SIZE UINT32_C(8)
#define FOZZIE_HELLO_FRAME_SIZE UINT32_C(32)
#define FOZZIE_RUN_FRAME_SIZE UINT32_C(24)
#define FOZZIE_STOP_FRAME_SIZE UINT32_C(16)
#define FOZZIE_DONE_FRAME_SIZE UINT32_C(40)

#define FOZZIE_SHM_MAGIC_INIT {'F', 'O', 'Z', 'Z', 'S', 'H', 'M', '\0'}

enum fozzie_frame_type {
    FOZZIE_FRAME_HELLO = 1,
    FOZZIE_FRAME_RUN = 2,
    FOZZIE_FRAME_STOP = 3,
    FOZZIE_FRAME_DONE = 4,
};

enum fozzie_runtime_capability {
    FOZZIE_CAP_INLINE_8BIT_COUNTERS = UINT64_C(1) << 0,
    FOZZIE_CAP_PC_TABLE = UINT64_C(1) << 1,
    FOZZIE_CAP_TRACE_CMP = UINT64_C(1) << 2,
};

enum fozzie_done_status {
    FOZZIE_DONE_OK = 0,
    FOZZIE_DONE_HARNESS_NONZERO = 1,
};

enum fozzie_done_flag {
    FOZZIE_DONE_FEATURES_TRUNCATED = UINT32_C(1) << 0,
    FOZZIE_DONE_COMPARISONS_TRUNCATED = UINT32_C(1) << 1,
};

enum fozzie_cmp_kind {
    FOZZIE_CMP_PLAIN = 0,
    FOZZIE_CMP_CONST = 1,
    FOZZIE_CMP_SWITCH = 2,
};

/*
 * All integer byte arrays in this header are little-endian. Byte-array fields
 * make the ABI independent of host structure padding and alignment.
 *
 * The engine creates one shared file with three non-overlapping regions. The
 * offsets and capacities are intentionally data, rather than ABI constants:
 *
 *   [fozzie_shm_header]
 *   [input_capacity bytes]
 *   [feature_capacity * sizeof(fozzie_feature_entry)]
 *   [cmp_capacity * sizeof(fozzie_cmp_entry)]
 */
struct fozzie_shm_header {
    uint8_t magic[8];
    uint8_t version_le[4];
    uint8_t header_size_le[4];
    uint8_t total_size_le[8];
    uint8_t input_offset_le[8];
    uint8_t input_capacity_le[8];
    uint8_t feature_offset_le[8];
    uint8_t feature_capacity_le[4];
    uint8_t feature_entry_size_le[4];
    uint8_t cmp_offset_le[8];
    uint8_t cmp_capacity_le[4];
    uint8_t cmp_entry_size_le[4];
    uint8_t flags_le[8];
    uint8_t reserved[48];
};

/* One sparse feature ID. IDs are (dense_counter_index << 3) | hit_bucket. */
struct fozzie_feature_entry {
    uint8_t feature_id_le[8];
};

/* A bounded trace-cmp observation. pc is the raw in-process return address. */
struct fozzie_cmp_entry {
    uint8_t pc_le[8];
    uint8_t arg1_le[8];
    uint8_t arg2_le[8];
    uint8_t sequence_le[4];
    uint8_t width;
    uint8_t kind;
    uint8_t reserved[2];
};

struct fozzie_frame_header {
    uint8_t size_le[4];
    uint8_t version_le[2];
    uint8_t type;
    uint8_t flags;
};

struct fozzie_hello_frame {
    struct fozzie_frame_header header;
    uint8_t layout_version_le[4];
    uint8_t reserved_le[4];
    uint8_t capabilities_le[8];
    uint8_t counter_count_le[8];
};

struct fozzie_run_frame {
    struct fozzie_frame_header header;
    uint8_t run_id_le[8];
    uint8_t input_size_le[8];
};

struct fozzie_stop_frame {
    struct fozzie_frame_header header;
    uint8_t reason_le[4];
    uint8_t reserved_le[4];
};

struct fozzie_done_frame {
    struct fozzie_frame_header header;
    uint8_t run_id_le[8];
    uint8_t status_le[4];
    uint8_t harness_return_le[4];
    uint8_t feature_count_le[4];
    uint8_t cmp_count_le[4];
    uint8_t done_flags_le[4];
    uint8_t reserved_le[4];
};

#if defined(__cplusplus)
#define FOZZIE_STATIC_ASSERT(condition, message) static_assert(condition, message)
#else
#define FOZZIE_STATIC_ASSERT(condition, message) _Static_assert(condition, message)
#endif

FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_shm_header) == FOZZIE_SHM_HEADER_SIZE,
    "fozzie_shm_header ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_feature_entry) == FOZZIE_FEATURE_ENTRY_SIZE,
    "fozzie_feature_entry ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_cmp_entry) == FOZZIE_CMP_ENTRY_SIZE,
    "fozzie_cmp_entry ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_frame_header) == FOZZIE_FRAME_HEADER_SIZE,
    "fozzie_frame_header ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_hello_frame) == FOZZIE_HELLO_FRAME_SIZE,
    "fozzie_hello_frame ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_run_frame) == FOZZIE_RUN_FRAME_SIZE,
    "fozzie_run_frame ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_stop_frame) == FOZZIE_STOP_FRAME_SIZE,
    "fozzie_stop_frame ABI changed");
FOZZIE_STATIC_ASSERT(sizeof(struct fozzie_done_frame) == FOZZIE_DONE_FRAME_SIZE,
    "fozzie_done_frame ABI changed");

static inline uint16_t fozzie_load_le16(const uint8_t bytes[2]) {
    return (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8);
}

static inline uint32_t fozzie_load_le32(const uint8_t bytes[4]) {
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) |
           ((uint32_t)bytes[3] << 24);
}

static inline uint64_t fozzie_load_le64(const uint8_t bytes[8]) {
    return (uint64_t)fozzie_load_le32(bytes) | ((uint64_t)fozzie_load_le32(bytes + 4) << 32);
}

static inline void fozzie_store_le16(uint8_t bytes[2], uint16_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

static inline void fozzie_store_le32(uint8_t bytes[4], uint32_t value) {
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
    bytes[2] = (uint8_t)(value >> 16);
    bytes[3] = (uint8_t)(value >> 24);
}

static inline void fozzie_store_le64(uint8_t bytes[8], uint64_t value) {
    fozzie_store_le32(bytes, (uint32_t)value);
    fozzie_store_le32(bytes + 4, (uint32_t)(value >> 32));
}

static inline void fozzie_init_frame_header(
    struct fozzie_frame_header* header, uint32_t size, uint8_t type) {
    fozzie_store_le32(header->size_le, size);
    fozzie_store_le16(header->version_le, FOZZIE_PROTOCOL_VERSION);
    header->type = type;
    header->flags = 0;
}

#if defined(__cplusplus)
} /* extern "C" */
#endif

#endif /* FOZZIE_RUNTIME_PROTOCOL_H */
