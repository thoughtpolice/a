# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def protoc_env():
    """Returns an env dict with PROTOC and PROTOC_INCLUDE for use in genrules.

    protoc is an exec dependency, built for the machine the genrule runs on.
    """
    return {
        "PROTOC": "$(exe toolchains//protoc:protoc)",
        "PROTOC_INCLUDE": "$(location toolchains//protoc:include)",
    }
