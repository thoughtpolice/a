// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A compute shader leaning on the core module: an interface and a generic
// over it, and forward-mode automatic differentiation.

interface IScale
{
    float apply(float x);
}

struct Doubler : IScale
{
    float apply(float x) { return 2.0 * x; }
}

[Differentiable]
float square(float x)
{
    return x * x;
}

float scaled<T : IScale>(T scale, float x)
{
    return scale.apply(x);
}

struct Params
{
    float bias;
}

ConstantBuffer<Params> params;
RWStructuredBuffer<float> data;

[shader("compute")]
[numthreads(64, 1, 1)]
void computeMain(uint3 tid: SV_DispatchThreadID)
{
    float x = data[tid.x];
    // d/dx x^2 = 2x.
    float slope = fwd_diff(square)(diffPair(x, 1.0)).d;
    data[tid.x] = scaled(Doubler(), x) + slope + params.bias;
}
