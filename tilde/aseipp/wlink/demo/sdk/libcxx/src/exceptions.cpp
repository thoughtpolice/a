// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The C++ exception runtime, on WebAssembly's own exception mechanism.
//
// The compiler turns `throw` into a call to __cxa_throw and a `throw` of the
// `__cpp_exception` tag, and turns a `try` into a `try_table` that catches
// that tag. What it leaves to a runtime is the part that decides whether a
// handler wants the exception that arrived, and the bookkeeping around the
// object while a handler has it.
//
// The deciding happens in a landing pad, which is the one place the compiler
// asks anything of us: it stores the index of the pad and the address of the
// table the compiler emitted for the function into __wasm_lpad_context, calls
// _Unwind_CallPersonality with the exception, and then reads a selector back
// out of that context to pick a handler. A selector that matches none of them
// leaves the pad by rethrowing the exception it caught, so propagation costs
// this runtime nothing: the machine does it.
//
// The table is the Itanium "GCC except table", in the shape the compiler
// emits for WebAssembly: a call-site table indexed by landing pad rather than
// by address, an action chain per pad, and a table of the types each action
// catches, read backwards from its end.

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <exception>
#include <typeinfo>

#include "console.h"

namespace std {
[[noreturn]] void __console_cxx_fail(const char* what);
}

// The tag every C++ exception is thrown with. Like the one setjmp uses, it
// has no spelling in C++, and the compiler names rather than indexes it.
__asm__(".tagtype __cpp_exception i32\n"
        ".globl __cpp_exception\n"
        "__cpp_exception:\n");

// ---------------------------------------------------------------------------
// Type information
//
// The compiler emits one of these objects for every type that is thrown or
// caught, and points it at a vtable by name, so the names and the data layout
// below are fixed by the ABI. What the vtable holds is not: nothing outside
// this file calls through it, so the virtual functions are the ones this
// runtime wants, which are the ones std::type_info already declares.

namespace __cxxabiv1 {

class __class_type_info;

// Anything whose identity alone decides a catch: fundamentals, enums, arrays
// and functions all match only themselves.
class __fundamental_type_info : public std::type_info {
public:
    explicit __fundamental_type_info(const char* name) : std::type_info(name) {}
    virtual ~__fundamental_type_info();
};

class __array_type_info : public std::type_info {
public:
    explicit __array_type_info(const char* name) : std::type_info(name) {}
    virtual ~__array_type_info();
};

class __enum_type_info : public std::type_info {
public:
    explicit __enum_type_info(const char* name) : std::type_info(name) {}
    virtual ~__enum_type_info();
};

// A class with no bases.
class __class_type_info : public std::type_info {
public:
    explicit __class_type_info(const char* name) : std::type_info(name) {}
    virtual ~__class_type_info();

    // A handler for a class type takes an exception of that class, or of any
    // class that has it as an accessible base. Whether the thrown type has it
    // is a question for the thrown type, which is what __do_upcast asks.
    bool __do_catch(const std::type_info* thrown, void** object, unsigned outer) const override;
    bool __do_upcast(const __class_type_info* target, void** object) const override;
};

// A class with one public, non-virtual base at offset zero, which is the
// common case and the only one that needs no arithmetic.
class __si_class_type_info : public __class_type_info {
public:
    explicit __si_class_type_info(const char* name, const __class_type_info* base)
        : __class_type_info(name), __base_type(base) {}
    virtual ~__si_class_type_info();

    bool __do_upcast(const __class_type_info* target, void** object) const override;

    const __class_type_info* __base_type;
};

// One base of a class that has several, or a virtual one.
struct __base_class_type_info {
    const __class_type_info* __base_type;
    long __offset_flags;

    enum __offset_flags_masks {
        __virtual_mask = 0x1,
        __public_mask = 0x2,
        __offset_shift = 8,
    };

    bool is_virtual() const { return (__offset_flags & __virtual_mask) != 0; }
    bool is_public() const { return (__offset_flags & __public_mask) != 0; }
    ptrdiff_t offset() const { return __offset_flags >> __offset_shift; }
};

// A class with several bases, or a virtual one.
class __vmi_class_type_info : public __class_type_info {
public:
    explicit __vmi_class_type_info(const char* name)
        : __class_type_info(name), __flags(0), __base_count(0), __base_info() {}
    virtual ~__vmi_class_type_info();

    bool __do_upcast(const __class_type_info* target, void** object) const override;

    unsigned int __flags;
    unsigned int __base_count;
    __base_class_type_info __base_info[1];
};

// Shared by pointers and pointers to members.
class __pbase_type_info : public std::type_info {
public:
    explicit __pbase_type_info(const char* name, unsigned flags,
                                         const std::type_info* pointee)
        : std::type_info(name), __flags(flags), __pointee(pointee) {}
    virtual ~__pbase_type_info();

    bool __do_catch(const std::type_info* thrown, void** object, unsigned outer) const override;

    enum __masks {
        __const_mask = 0x1,
        __volatile_mask = 0x2,
        __restrict_mask = 0x4,
        __incomplete_mask = 0x8,
        __incomplete_class_mask = 0x10,
        __transaction_safe_mask = 0x20,
        __noexcept_mask = 0x40,
    };

    unsigned int __flags;
    const std::type_info* __pointee;
};

class __pointer_type_info : public __pbase_type_info {
public:
    explicit __pointer_type_info(const char* name, unsigned flags,
                                           const std::type_info* pointee)
        : __pbase_type_info(name, flags, pointee) {}
    virtual ~__pointer_type_info();

    bool __is_pointer_p() const override;
};

class __pointer_to_member_type_info : public __pbase_type_info {
public:
    explicit __pointer_to_member_type_info(const char* name, unsigned flags,
                                                     const std::type_info* pointee,
                                                     const __class_type_info* context)
        : __pbase_type_info(name, flags, pointee), __context(context) {}
    virtual ~__pointer_to_member_type_info();

    const __class_type_info* __context;
};

// The destructors are the key functions: defining each one here is what puts
// its class's vtable in this object file, which is the symbol the compiler
// emitted a reference to.
__fundamental_type_info::~__fundamental_type_info() {}
__array_type_info::~__array_type_info() {}
__enum_type_info::~__enum_type_info() {}
__class_type_info::~__class_type_info() {}
__si_class_type_info::~__si_class_type_info() {}
__vmi_class_type_info::~__vmi_class_type_info() {}
__pbase_type_info::~__pbase_type_info() {}
__pointer_type_info::~__pointer_type_info() {}
__pointer_to_member_type_info::~__pointer_to_member_type_info() {}

bool __class_type_info::__do_catch(const std::type_info* thrown, void** object,
                                   unsigned outer) const {
    (void)outer;
    if (*this == *thrown) return true;
    // Asking the thrown type walks its bases, adjusting the object as it goes.
    return thrown->__do_upcast(this, object);
}

bool __class_type_info::__do_upcast(const __class_type_info* target, void** object) const {
    (void)object;
    return *this == *target;
}

bool __si_class_type_info::__do_upcast(const __class_type_info* target, void** object) const {
    if (*this == *target) return true;
    // The base sits at the start of the object, so the pointer is unchanged.
    return __base_type->__do_upcast(target, object);
}

bool __vmi_class_type_info::__do_upcast(const __class_type_info* target, void** object) const {
    if (*this == *target) return true;
    for (unsigned int at = 0; at < __base_count; ++at) {
        const __base_class_type_info& base = __base_info[at];
        // A base reached through a virtual path needs the object's own vtable
        // to find, which this runtime does not read; a private base is not a
        // path a handler may take anyway.
        if (base.is_virtual() || !base.is_public()) continue;
        void* adjusted = static_cast<char*>(*object) + base.offset();
        if (base.__base_type->__do_upcast(target, &adjusted)) {
            *object = adjusted;
            return true;
        }
    }
    return false;
}

bool __pbase_type_info::__do_catch(const std::type_info* thrown, void** object,
                                   unsigned outer) const {
    if (*this == *thrown) return true;
    if (!thrown->__is_pointer_p()) return false;
    const __pbase_type_info* from = static_cast<const __pbase_type_info*>(thrown);
    // A handler may add qualifiers to what it catches but never drop them.
    if (from->__flags & ~__flags) return false;
    if (*__pointee == *from->__pointee) return true;
    // A pointer to a derived class is caught by a pointer to its base, and
    // the pointer itself is what moves.
    if (object && *object) {
        void* target = *static_cast<void**>(*object);
        if (target && __pointee->__do_catch(from->__pointee, &target, outer + 2)) {
            *static_cast<void**>(*object) = target;
            return true;
        }
    }
    return false;
}

bool __pointer_type_info::__is_pointer_p() const { return true; }

}  // namespace __cxxabiv1

// The parts of std::type_info the compiler leaves to the library. Defining
// the destructor here is what emits its vtable, which every one of the
// classes above needs underneath its own.
namespace std {

type_info::~type_info() {}

bool type_info::__is_pointer_p() const { return false; }
bool type_info::__is_function_p() const { return false; }

bool type_info::__do_catch(const type_info* thrown, void** object, unsigned outer) const {
    (void)object;
    (void)outer;
    return *this == *thrown;
}

bool type_info::__do_upcast(const __cxxabiv1::__class_type_info* target, void** object) const {
    (void)target;
    (void)object;
    return false;
}

}  // namespace std

// The type information for the built-in types, which the compiler references
// by name and expects a library to define.
#define CONSOLE_FUNDAMENTAL(mangled, spelling)                                            \
    extern "C" const __cxxabiv1::__fundamental_type_info console_type_info_##spelling     \
        __asm__("_ZTI" #mangled);                                                         \
    const __cxxabiv1::__fundamental_type_info console_type_info_##spelling(#mangled)

CONSOLE_FUNDAMENTAL(v, void);
CONSOLE_FUNDAMENTAL(b, bool);
CONSOLE_FUNDAMENTAL(c, char);
CONSOLE_FUNDAMENTAL(a, signed_char);
CONSOLE_FUNDAMENTAL(h, unsigned_char);
CONSOLE_FUNDAMENTAL(s, short);
CONSOLE_FUNDAMENTAL(t, unsigned_short);
CONSOLE_FUNDAMENTAL(i, int);
CONSOLE_FUNDAMENTAL(j, unsigned_int);
CONSOLE_FUNDAMENTAL(l, long);
CONSOLE_FUNDAMENTAL(m, unsigned_long);
CONSOLE_FUNDAMENTAL(x, long_long);
CONSOLE_FUNDAMENTAL(y, unsigned_long_long);
CONSOLE_FUNDAMENTAL(f, float);
CONSOLE_FUNDAMENTAL(d, double);
CONSOLE_FUNDAMENTAL(e, long_double);
CONSOLE_FUNDAMENTAL(Dn, nullptr_t);
CONSOLE_FUNDAMENTAL(w, wchar_t);
CONSOLE_FUNDAMENTAL(Du, char8_t);
CONSOLE_FUNDAMENTAL(Ds, char16_t);
CONSOLE_FUNDAMENTAL(Di, char32_t);

#undef CONSOLE_FUNDAMENTAL

// ---------------------------------------------------------------------------
// Exceptions in flight

namespace {

// What a thrown exception is, as this runtime sees it. The object the program
// threw follows the header, so the two are allocated and freed together and
// either can be found from the other.
// The compiler gives a destructor on this target its object back as a result
// rather than returning nothing, and WebAssembly checks the type of an
// indirect call, so a pointer to one cannot be spelled as returning void.
using Destructor = void* (*)(void*);

struct Exception {
    const std::type_info* type;
    Destructor destructor;
    // What a handler is given: the thrown object, or the base of it that the
    // handler asked to catch.
    void* object;
    // How many handlers have this exception in hand, which is what says
    // whether leaving a handler is the end of it.
    int handlers;
    // Whether a handler threw it onwards, in which case leaving that handler
    // is not the end of it.
    bool rethrown;
    // The exception a handler was already holding when this one was caught,
    // so that the set of them nests.
    Exception* previous;
};

Exception* header_of(void* object) { return static_cast<Exception*>(object) - 1; }
void* object_of(Exception* exception) { return exception + 1; }

// The exception the innermost active handler is holding. The console runs a
// guest on one thread, so one of these is enough.
Exception* caught;

// The landing pad the compiler is asking about, and the answer. The compiler
// writes the first two fields and reads the third; the layout is its own.
struct LandingPadContext {
    uintptr_t index;
    uintptr_t table;
    uintptr_t selector;
};

// LEB128, as the tables are written in.
uintptr_t read_unsigned(const uint8_t** at) {
    uintptr_t result = 0;
    unsigned shift = 0;
    uint8_t byte;
    do {
        byte = *(*at)++;
        result |= static_cast<uintptr_t>(byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    return result;
}

intptr_t read_signed(const uint8_t** at) {
    intptr_t result = 0;
    unsigned shift = 0;
    uint8_t byte;
    do {
        byte = *(*at)++;
        result |= static_cast<intptr_t>(byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    if (shift < sizeof(intptr_t) * 8 && (byte & 0x40)) {
        result |= -(static_cast<intptr_t>(1) << shift);
    }
    return result;
}

const uint8_t kOmit = 0xff;

// Walks the table the compiler emitted for one function and answers, for the
// landing pad it is asking about, which of that pad's handlers wants this
// exception. Zero means none of them do, which the pad takes as a signal to
// throw the exception onwards.
uintptr_t select_handler(const uint8_t* table, uintptr_t pad, Exception* exception,
                         void** object) {
    if (!table) return 0;

    const uint8_t* at = table;
    if (*at++ != kOmit) {
        // A landing pad base, which the compiler does not emit for
        // WebAssembly because pads are named by index rather than by address.
        std::__console_cxx_fail("exception table has a landing pad base");
    }

    // The table of caught types, read backwards from the end this points at.
    const uint8_t* types_end = nullptr;
    uint8_t type_encoding = *at++;
    if (type_encoding != kOmit) {
        if (type_encoding != 0) {
            std::__console_cxx_fail("exception table types are not plain addresses");
        }
        uintptr_t offset = read_unsigned(&at);
        types_end = at + offset;
    }

    if (*at++ != 1) std::__console_cxx_fail("exception table call sites are not uleb128");
    uintptr_t call_sites_length = read_unsigned(&at);
    const uint8_t* call_sites = at;
    const uint8_t* actions = call_sites + call_sites_length;

    // One entry per landing pad: which pad, and where its actions start.
    uintptr_t action_offset = 0;
    bool found = false;
    at = call_sites;
    while (at < actions) {
        uintptr_t which = read_unsigned(&at);
        uintptr_t action = read_unsigned(&at);
        if (which == pad) {
            action_offset = action;
            found = true;
            break;
        }
    }
    // A pad with no entry catches nothing, which is what a pad that only runs
    // destructors looks like.
    if (!found || action_offset == 0) return 0;

    const uint8_t* action = actions + action_offset - 1;
    while (true) {
        intptr_t filter = read_signed(&action);
        const uint8_t* next_field = action;
        intptr_t next = read_signed(&action);

        if (filter > 0) {
            // Types are numbered from one, backwards from the end of the
            // table; the entry for a `catch (...)` is a null.
            const std::type_info* const* entry =
                reinterpret_cast<const std::type_info* const*>(types_end) - filter;
            const std::type_info* wanted = *entry;
            void* candidate = object_of(exception);
            if (!wanted || wanted->__do_catch(exception->type, &candidate, 1)) {
                *object = candidate;
                return static_cast<uintptr_t>(filter);
            }
        } else if (filter < 0) {
            // An exception specification, which this runtime does not
            // enforce: those were removed from the language in C++17.
        }

        if (next == 0) return 0;
        // The offset is measured from the field it was read out of.
        action = next_field + next;
    }
}

}  // namespace

extern "C" {

// What the compiler tells the personality, and what it reads back. The name
// and the layout are the compiler's: it stores the landing pad's index and
// the address of the function's table, and picks a handler from the selector.
LandingPadContext __wasm_lpad_context;

// Called from a landing pad, once, for the exception it caught.
int _Unwind_CallPersonality(void* thrown) {
    Exception* exception = header_of(thrown);
    void* object = object_of(exception);
    __wasm_lpad_context.selector =
        select_handler(reinterpret_cast<const uint8_t*>(__wasm_lpad_context.table),
                       __wasm_lpad_context.index, exception, &object);
    // A handler that catches a base class of what was thrown is given a
    // pointer to that base, which is what the adjustment above worked out.
    exception->object = object;
    return 0;
}

void* __cxa_allocate_exception(size_t size) noexcept {
    Exception* exception = static_cast<Exception*>(malloc(sizeof(Exception) + size));
    if (!exception) std::__console_cxx_fail("out of memory while throwing");
    memset(exception, 0, sizeof(Exception));
    return object_of(exception);
}

void __cxa_free_exception(void* thrown) noexcept { free(header_of(thrown)); }

[[noreturn]] void __cxa_throw(void* thrown, std::type_info* type, Destructor destructor) {
    Exception* exception = header_of(thrown);
    exception->type = type;
    exception->destructor = destructor;
    exception->object = thrown;
    exception->handlers = 0;
    exception->previous = nullptr;
    // Zero names the C++ exception tag, which the compiler turns into the
    // symbol declared at the top of this file rather than a tag index. What
    // travels with it is the thrown object, which is what every other entry
    // point here is handed and what the header is found from.
    __builtin_wasm_throw(0, thrown);
}

// Entering a handler. The exception stays alive until every handler holding
// it has left, and the one being entered nests inside whatever was already
// caught.
void* __cxa_begin_catch(void* thrown) noexcept {
    Exception* exception = header_of(thrown);
    if (exception->handlers == 0) {
        exception->previous = caught;
        caught = exception;
    }
    exception->handlers += 1;
    return exception->object;
}

void __cxa_end_catch() {
    Exception* exception = caught;
    if (!exception) return;
    exception->handlers -= 1;
    if (exception->handlers > 0) return;
    caught = exception->previous;
    // A rethrown exception is still in flight and must outlive the handler
    // that threw it onwards; the throw below marked it so.
    if (exception->rethrown) return;
    if (exception->destructor) exception->destructor(object_of(exception));
    free(exception);
}

// `throw;` inside a handler, which sends the same exception onwards rather
// than making another one.
[[noreturn]] void __cxa_rethrow() {
    Exception* exception = caught;
    if (!exception) std::terminate();
    exception->rethrown = true;
    __builtin_wasm_throw(0, object_of(exception));
}

// The object a handler is holding, for code that asks after it.
void* __cxa_get_exception_ptr(void* thrown) noexcept { return header_of(thrown)->object; }

}  // extern "C"

namespace {

std::terminate_handler chosen_terminate = nullptr;

}  // namespace

namespace std {

terminate_handler set_terminate(terminate_handler handler) noexcept {
    terminate_handler previous = chosen_terminate;
    chosen_terminate = handler;
    return previous;
}

terminate_handler get_terminate() noexcept { return chosen_terminate; }

void terminate() noexcept {
    if (chosen_terminate) chosen_terminate();
    __console_cxx_fail("terminate called");
}

}  // namespace std
