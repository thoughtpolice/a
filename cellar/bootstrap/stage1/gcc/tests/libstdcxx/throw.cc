/* SPDX-FileCopyrightText: 2026 Austin Seipp
 * SPDX-License-Identifier: MIT */
#include "exception.h"
#include <exception>
#include <cstdlib>
struct Cleanup {
    int *count;
    ~Cleanup() { if (!std::uncaught_exception()) std::abort(); ++*count; }
};
void throw_separately(int *cleaned)
{
    Cleanup cleanup = { cleaned };
    throw Derived();
}
