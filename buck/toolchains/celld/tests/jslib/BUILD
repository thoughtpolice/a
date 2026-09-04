# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@toolchains//celld:defs.bzl", "celld")

celld.worker(
    name = "worker",
    main = "worker.ts",
    deps = ["toolchains//js/tests:plain"],
)

celld.project(
    name = "project",
    src = ":worker",
    script_name = "generic-js-library",
)

celld.deploy_test(
    name = "deploy-test",
    project = ":project",
)
