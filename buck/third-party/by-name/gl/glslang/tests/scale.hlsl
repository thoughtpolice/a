// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

RWStructuredBuffer<float> data : register(u0);

cbuffer Params : register(b0)
{
    float scale;
};

[numthreads(64, 1, 1)]
void main(uint3 tid : SV_DispatchThreadID)
{
    data[tid.x] = data[tid.x] * scale;
}
