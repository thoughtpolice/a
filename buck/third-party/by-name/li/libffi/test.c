// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Call a C function through ffi_call, then call a closure built with
// ffi_closure_alloc as an ordinary function pointer.

#include <ffi.h>
#include <stdio.h>
#include <string.h>

static double scale(int n, double x) { return n * x; }

// The closure's body: sums its two int arguments plus a bias in user_data.
static void add_with_bias(ffi_cif *cif, void *ret, void **args, void *user_data) {
    (void)cif;
    *(ffi_arg *)ret = *(int *)args[0] + *(int *)args[1] + *(int *)user_data;
}

int main(void) {
    if (strcmp(ffi_get_version(), FFI_VERSION_STRING) != 0 || ffi_get_version_number() != FFI_VERSION_NUMBER)
        return fprintf(stderr, "version: %s %lu\n", ffi_get_version(), ffi_get_version_number()), 1;

    ffi_cif cif;
    ffi_type *call_args[] = {&ffi_type_sint, &ffi_type_double};
    if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_double, call_args) != FFI_OK)
        return fprintf(stderr, "ffi_prep_cif failed\n"), 1;
    int n = 3;
    double x = 2.5, product = 0;
    void *values[] = {&n, &x};
    ffi_call(&cif, FFI_FN(scale), &product, values);
    if (product != 7.5) return fprintf(stderr, "ffi_call: %g\n", product), 1;

    void *code;
    ffi_closure *closure = ffi_closure_alloc(sizeof(ffi_closure), &code);
    if (closure == NULL) return fprintf(stderr, "ffi_closure_alloc failed\n"), 1;
    ffi_cif closure_cif;
    ffi_type *closure_args[] = {&ffi_type_sint, &ffi_type_sint};
    int bias = 100;
    if (ffi_prep_cif(&closure_cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint, closure_args) != FFI_OK ||
        ffi_prep_closure_loc(closure, &closure_cif, add_with_bias, &bias, code) != FFI_OK)
        return fprintf(stderr, "closure setup failed\n"), 1;
    int (*add)(int, int) = (int (*)(int, int))code;
    int sum = add(20, 22);
    ffi_closure_free(closure);
    if (sum != 142) return fprintf(stderr, "closure: %d\n", sum), 1;
    return 0;
}
