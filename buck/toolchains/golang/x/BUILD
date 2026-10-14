# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "go_x")
load(":packages.bzl", "X_PACKAGES")

# The golang.org/x modules every Go target can import; see defs.bzl. One
# version of each, consistent with the others' go.mod requirements, at the
# module proxy's zip checksum. After changing one, regenerate packages.bzl:
#
#   buck2 run toolchains//golang/x:manifest -- -w buck/toolchains/golang/x/packages.bzl
GO_X_MODULES = {
    "golang.org/x/crypto": ("v0.58.0", "b0a45594cda20ddb4264d84aeff9b588b8570bf6a2833c51a0b821734a298d95"),
    "golang.org/x/net": ("v0.61.0", "f6843a98d608298e48a6ca287292c9a6fae066284050ce174d5ffb781c9b3dcf"),
    "golang.org/x/oauth2": ("v0.37.0", "82b0472ff31d57867bfb95e28c2906acd54764949a215b6a01bda40f4ae4c3bd"),
    "golang.org/x/sys": ("v0.49.0", "e73a06591ca0d7016ce3ccb45c36a8ed7128468aecc1a357f94d815c760c6b31"),
    "golang.org/x/term": ("v0.47.0", "d990d5ab94dfa41ba980645b721bba7490064337a01bb03e6cacace70e8df0bf"),
    "golang.org/x/text": ("v0.43.0", "b75131f628f6e2e4892fd638d33127e952a5027775e0162b94ba069cb4e13863"),
    "golang.org/x/time": ("v0.16.0", "ac27777be8088859ba3b1bea3648064dc95ff8bac3023b1b059d1ab126dc729e"),
}

go_x(
    name = "x",
    modules = GO_X_MODULES,
    packages = X_PACKAGES,
)

shims.go_test(
    name = "x-test",
    srcs = ["x_test.go"],
)
