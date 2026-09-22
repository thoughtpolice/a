/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: Apache-2.0 */
#include "bconfig.h"
#include "system.h"
#include "coretypes.h"
#include "machmode.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "mode check failed at %d\n", __LINE__); return 1; } } while (0)
int main(void)
{
    CHECK(sizeof(HOST_WIDE_INT) == 8);
    CHECK(GET_MODE_CLASS(DImode) == MODE_INT);
    CHECK(GET_MODE_CLASS(TImode) == MODE_INT);
    CHECK(GET_MODE_CLASS(XFmode) == MODE_FLOAT);
    CHECK(GET_MODE_CLASS(TFmode) == MODE_FLOAT);
    CHECK(GET_MODE_CLASS(V4DFmode) == MODE_VECTOR_FLOAT);
    CHECK(GET_MODE_CLASS(V8SImode) == MODE_VECTOR_INT);
    CHECK(GET_MODE_CLASS(TDmode) == MODE_DECIMAL_FLOAT);
    CHECK(!strcmp(GET_MODE_NAME(DImode), "DI"));
    CHECK(!strcmp(GET_MODE_NAME(XFmode), "XF"));
    CHECK(!strcmp(GET_MODE_NAME(V8SImode), "V8SI"));
    CHECK(GET_MODE_WIDER_MODE(SImode) == DImode);
    CHECK(GET_MODE_WIDER_MODE(DImode) == TImode);
    CHECK(GET_MODE_WIDER_MODE(SDmode) == DDmode);
    CHECK(GET_MODE_WIDER_MODE(DDmode) == TDmode);
    CHECK(GET_CLASS_NARROWEST_MODE(MODE_INT) == QImode);
    return 0;
}
