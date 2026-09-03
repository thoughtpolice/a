// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The object the compiler emits for every type that is thrown or caught. The
// name and the data layout are fixed by the Itanium ABI; the virtual
// functions are not, and these are the ones `src/exceptions.cpp` asks of a
// type when it is deciding whether a handler wants what arrived.
//
// Guests build with -fno-rtti, so nothing here is reachable through `typeid`
// and there is no bad_cast to throw: this is the exception runtime's view of
// a type, and only that.

#ifndef CONSOLE_CXX_TYPEINFO
#define CONSOLE_CXX_TYPEINFO

namespace __cxxabiv1 {
class __class_type_info;
}

namespace std {

class type_info {
public:
    type_info(const type_info&) = delete;
    type_info& operator=(const type_info&) = delete;

    // The key function, defined in src/exceptions.cpp along with the vtable
    // every __cxxabiv1 type below it inherits.
    virtual ~type_info();

    const char* name() const noexcept { return __name; }

    // Two objects for the same type can be distinct when a type crosses a
    // translation unit, so the mangled name decides rather than the address.
    bool operator==(const type_info& other) const noexcept {
        return __name == other.__name || __builtin_strcmp(__name, other.__name) == 0;
    }

    bool operator!=(const type_info& other) const noexcept { return !(*this == other); }

    bool before(const type_info& other) const noexcept {
        return __builtin_strcmp(__name, other.__name) < 0;
    }

    virtual bool __is_pointer_p() const;
    virtual bool __is_function_p() const;

    // Whether a handler for this type takes an exception of the thrown one,
    // adjusting the object to the base the handler asked for if it does.
    virtual bool __do_catch(const type_info* thrown, void** object, unsigned outer) const;

    // Whether this type has the target as an accessible base, adjusting the
    // object to it on the way.
    virtual bool __do_upcast(const __cxxabiv1::__class_type_info* target, void** object) const;

protected:
    explicit type_info(const char* name) : __name(name) {}

    // The mangled name, which is the _ZTS symbol the compiler emitted.
    const char* __name;
};

}  // namespace std

#endif
