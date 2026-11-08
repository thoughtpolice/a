// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Compile a module from a string through the C++ API, as an application
// embedding libslang-compiler would, and check the SPIR-V and reflection.

#include <slang-com-ptr.h>
#include <slang.h>

#include <cstdio>
#include <cstring>

using Slang::ComPtr;

static const char* kSource = R"(
RWStructuredBuffer<uint> output;

[shader("compute")]
[numthreads(8, 1, 1)]
void computeMain(uint3 tid : SV_DispatchThreadID)
{
    output[tid.x] = tid.x * tid.x;
}
)";

static int fail(const char* what, slang::IBlob* diagnostics)
{
    std::fprintf(stderr, "%s failed\n", what);
    if (diagnostics)
        std::fprintf(stderr, "%s\n", (const char*)diagnostics->getBufferPointer());
    return 1;
}

int main()
{
    ComPtr<slang::IGlobalSession> global;
    if (SLANG_FAILED(slang::createGlobalSession(global.writeRef())))
        return fail("createGlobalSession", nullptr);

    // Unoptimized: optimizing SPIR-V needs libslang-glslang, which is
    // installed beside libslang-compiler in :dist but not beside the copy
    // this test links.
    slang::CompilerOptionEntry optimization = {};
    optimization.name = slang::CompilerOptionName::Optimization;
    optimization.value.kind = slang::CompilerOptionValueKind::Int;
    optimization.value.intValue0 = SLANG_OPTIMIZATION_LEVEL_NONE;

    slang::TargetDesc target = {};
    target.format = SLANG_SPIRV;
    target.profile = global->findProfile("spirv_1_5");

    slang::SessionDesc desc = {};
    desc.targets = &target;
    desc.targetCount = 1;
    desc.compilerOptionEntries = &optimization;
    desc.compilerOptionEntryCount = 1;

    ComPtr<slang::ISession> session;
    if (SLANG_FAILED(global->createSession(desc, session.writeRef())))
        return fail("createSession", nullptr);

    ComPtr<slang::IBlob> diagnostics;
    slang::IModule* module =
        session->loadModuleFromSourceString("squares", "squares.slang", kSource, diagnostics.writeRef());
    if (!module)
        return fail("loadModuleFromSourceString", diagnostics);

    ComPtr<slang::IEntryPoint> entryPoint;
    if (SLANG_FAILED(module->findEntryPointByName("computeMain", entryPoint.writeRef())))
        return fail("findEntryPointByName", nullptr);

    slang::IComponentType* parts[] = {module, entryPoint};
    ComPtr<slang::IComponentType> program, linked;
    if (SLANG_FAILED(session->createCompositeComponentType(parts, 2, program.writeRef(), diagnostics.writeRef())))
        return fail("createCompositeComponentType", diagnostics);
    if (SLANG_FAILED(program->link(linked.writeRef(), diagnostics.writeRef())))
        return fail("link", diagnostics);

    ComPtr<slang::IBlob> code;
    if (SLANG_FAILED(linked->getEntryPointCode(0, 0, code.writeRef(), diagnostics.writeRef())))
        return fail("getEntryPointCode", diagnostics);

    const unsigned magic = 0x07230203;
    if (code->getBufferSize() < 20 || std::memcmp(code->getBufferPointer(), &magic, 4) != 0)
        return fail("SPIR-V magic number check", nullptr);

    slang::ProgramLayout* layout = linked->getLayout();
    if (layout->getParameterCount() != 1 || std::strcmp(layout->getParameterByIndex(0)->getName(), "output") != 0)
        return fail("reflection of the output parameter", nullptr);
    SlangUInt size[3] = {};
    layout->getEntryPointByIndex(0)->getComputeThreadGroupSize(3, size);
    if (size[0] != 8 || size[1] != 1 || size[2] != 1)
        return fail("reflection of the thread group size", nullptr);

    std::printf("spirv: %zu bytes\n", code->getBufferSize());
    return 0;
}
