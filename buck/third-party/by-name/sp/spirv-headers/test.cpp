// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C and C++ headers agree with each other and with the SPIR-V spec.

#include <cstdio>
#include <spirv/unified1/GLSL.std.450.h>
#include <spirv/unified1/NonSemanticShaderDebugInfo100.h>
#include <spirv/unified1/spirv.h>
#include <spirv/unified1/spirv.hpp11>

int main() {
    static_assert(SpvMagicNumber == 0x07230203, "magic number");
    static_assert(static_cast<unsigned>(spv::Op::OpCapability) == SpvOpCapability, "C and C++ opcodes differ");
    static_assert(GLSLstd450Round == 1, "GLSL.std.450 numbering");
    static_assert(NonSemanticShaderDebugInfo100DebugCompilationUnit == 1, "debug info numbering");
    if (SpvVersion < 0x00010600) return std::puts("unified1 predates SPIR-V 1.6"), 1;
    return 0;
}
