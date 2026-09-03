// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The base every thrown standard type derives from, and the handler the
// runtime calls when there is nowhere left to throw to. Both are declared
// here and defined in this library, not in one shipped for the host.

#ifndef CONSOLE_CXX_EXCEPTION
#define CONSOLE_CXX_EXCEPTION

namespace std {

class exception {
public:
    exception() noexcept = default;
    exception(const exception&) noexcept = default;
    exception& operator=(const exception&) noexcept = default;

    // The key function: defining it is what puts this class's vtable in the
    // library rather than in every guest that names the type.
    virtual ~exception() noexcept;
    virtual const char* what() const noexcept;
};

using terminate_handler = void (*)();

terminate_handler set_terminate(terminate_handler handler) noexcept;
terminate_handler get_terminate() noexcept;

// Reported through the console log before the guest is stopped. There is no
// exception_ptr here and nothing to rethrow from: an exception the guest did
// not catch is the end of the run.
[[noreturn]] void terminate() noexcept;

}  // namespace std

#endif
