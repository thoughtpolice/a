-- SPDX-FileCopyrightText: © 2026 Austin Seipp
-- SPDX-License-Identifier: Apache-2.0

module

public import NativeLocal.Ffi
-- NativeLocal.Ffi is in this target, so its code is not in a library this
-- module could load. :native-local precompiles module by module, and this
-- module loads NativeLocal.Ffi's shared object while it elaborates.
meta import NativeLocal.Ffi

#guard fma 6 7 0 == 42
#guard answerPlus 1 == 43
