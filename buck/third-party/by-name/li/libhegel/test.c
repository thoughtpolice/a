// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#include <hegel.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Keep checks active in release builds, including calls with side effects.
#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
        exit(1); \
    } \
} while (0)

#define OK(call) do { \
    hegel_result_t code = (call); \
    if (code != HEGEL_OK) { \
        fprintf(stderr, "%s: %d: %s\n", #call, code, \
                hegel_context_last_error(ctx)); \
        exit(1); \
    } \
} while (0)

// Exercise the pull-based protocol used by language bindings: generate,
// report outcomes, shrink a failure, and replay the minimal counterexample.
static void exercise_run(hegel_context_t *ctx, bool failing) {
    hegel_settings_t *settings = NULL;
    OK(hegel_settings_new(ctx, &settings));
    OK(hegel_settings_set_backend(ctx, settings, HEGEL_BACKEND_DEFAULT));
    OK(hegel_settings_set_database(ctx, settings, ""));
    OK(hegel_settings_set_seed(ctx, settings, 42, true));
    OK(hegel_settings_set_test_cases(ctx, settings, 100));
    OK(hegel_settings_set_verbosity(ctx, settings, HEGEL_VERBOSITY_QUIET));

    hegel_run_t *run = NULL;
    OK(hegel_run_start(ctx, settings, NULL, NULL, &run));
    size_t cases = 0;
    for (;;) {
        hegel_test_case_t *tc = NULL;
        OK(hegel_next_test_case(ctx, run, &tc));
        if (tc == NULL) {
            break;
        }
        CHECK(++cases < 10000);
        int64_t value = -1;
        hegel_result_t draw = hegel_generate_integer(ctx, tc, 0, 100, &value);
        if (draw == HEGEL_E_STOP_TEST) {
            OK(hegel_mark_complete(ctx, tc, HEGEL_STATUS_OVERRUN, NULL));
            OK(hegel_test_case_free(ctx, tc));
            continue;
        }
        OK(draw);
        CHECK(value >= 0 && value <= 100);
        bool failed = failing && value >= 10;
        OK(hegel_mark_complete(ctx, tc,
                               failed ? HEGEL_STATUS_INTERESTING : HEGEL_STATUS_VALID,
                               failed ? "value >= 10" : NULL));
        OK(hegel_test_case_free(ctx, tc));
    }
    CHECK(cases > 0);

    hegel_run_result_t *result = NULL;
    OK(hegel_run_result(ctx, run, &result));
    OK(hegel_run_free(ctx, run));
    hegel_run_status_t status = HEGEL_RUN_STATUS_ERROR;
    OK(hegel_run_result_status(ctx, result, &status));
    CHECK(status == (failing ? HEGEL_RUN_STATUS_FAILED : HEGEL_RUN_STATUS_PASSED));
    size_t failures = 0;
    OK(hegel_run_result_failure_count(ctx, result, &failures));
    CHECK(failures == (failing ? 1 : 0));

    if (failing) {
        hegel_failure_t *failure = NULL;
        OK(hegel_run_result_failure(ctx, result, 0, &failure));
        const char *origin = NULL;
        OK(hegel_failure_origin(ctx, failure, &origin));
        CHECK(origin != NULL && strcmp(origin, "value >= 10") == 0);
        const char *blob = NULL;
        OK(hegel_failure_reproduction_blob(ctx, failure, &blob));
        CHECK(blob != NULL && blob[0] != '\0');
        hegel_test_case_t *replay = NULL;
        OK(hegel_test_case_from_blob(ctx, settings, blob, NULL, NULL, &replay));
        int64_t minimal = -1;
        OK(hegel_generate_integer(ctx, replay, 0, 100, &minimal));
        CHECK(minimal == 10);
        OK(hegel_mark_complete(ctx, replay, HEGEL_STATUS_INTERESTING, origin));
        OK(hegel_test_case_free(ctx, replay));
        OK(hegel_failure_free(ctx, failure));
    }

    OK(hegel_run_result_free(ctx, result));
    OK(hegel_settings_free(ctx, settings));
}

int main(void) {
    hegel_context_t *ctx = hegel_context_new();
    CHECK(ctx != NULL);
    const char *version = NULL;
    OK(hegel_version(ctx, &version));
    CHECK(version != NULL && strcmp(version, HEGEL_EXPECTED_VERSION) == 0);

    // Foreign callers receive an error code and a diagnostic for bad handles.
    CHECK(hegel_settings_set_test_cases(ctx, NULL, 1) == HEGEL_E_INVALID_HANDLE);
    const char *error = hegel_context_last_error(ctx);
    CHECK(error != NULL && error[0] != '\0');

    exercise_run(ctx, false);
    exercise_run(ctx, true);
    CHECK(hegel_context_free(ctx) == HEGEL_OK);
    return 0;
}
