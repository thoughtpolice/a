# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for adapting prelude tests to InternalRunnerTestInfo."""

def nonnegative_float_or_none(text: str) -> [None, float]:
    # float() fails hard on malformed input, so validate the small duration
    # grammar used by the Rust and Go harnesses first.
    if not text:
        return None
    dots = 0
    digits = 0
    for c in text.elems():
        if c == ".":
            dots += 1
        elif c.isdigit():
            digits += 1
        else:
            return None
    if dots > 1 or digits == 0:
        return None
    return float(text)

def internal_runner_from_external(
        external,
        command,
        listing_command,
        parse_test_listing,
        parse_test_result):
    """Copy execution policy from a prelude external test into an internal one."""
    return InternalRunnerTestInfo(
        # The provider constructor calls this `type`, while its readable field
        # is exposed as `test_type`.
        type = external.test_type,
        command = command,
        listing_command = listing_command,
        env = external.env,
        labels = external.labels,
        contacts = external.contacts,
        run_from_project_root = external.run_from_project_root,
        use_project_relative_paths = external.use_project_relative_paths,
        default_executor = external.default_executor,
        executor_overrides = external.executor_overrides,
        local_resources = external.local_resources,
        required_local_resources = external.required_local_resources,
        worker = external.worker,
        supports_test_execution_caching = external.supports_test_execution_caching,
        parse_test_listing = parse_test_listing,
        parse_test_result = parse_test_result,
    )
