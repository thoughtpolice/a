// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The standard exception types, for code that names them in declarations.
// Guests are built without exceptions, so constructing one of these is a
// fatal error rather than something a handler could recover from.

#ifndef CONSOLE_CXX_STDEXCEPT
#define CONSOLE_CXX_STDEXCEPT

#include <__cxx_support>
#include <exception>
#include <string>

namespace std {

class logic_error : public exception {
public:
    explicit logic_error(const string& what) : what_(what) {}
    explicit logic_error(const char* what) : what_(what) {}
    const char* what() const noexcept override { return what_.c_str(); }

private:
    string what_;
};

class runtime_error : public exception {
public:
    explicit runtime_error(const string& what) : what_(what) {}
    explicit runtime_error(const char* what) : what_(what) {}
    const char* what() const noexcept override { return what_.c_str(); }

private:
    string what_;
};

class out_of_range : public logic_error {
public:
    using logic_error::logic_error;
};

class length_error : public logic_error {
public:
    using logic_error::logic_error;
};

class invalid_argument : public logic_error {
public:
    using logic_error::logic_error;
};

class overflow_error : public runtime_error {
public:
    using runtime_error::runtime_error;
};

}  // namespace std

#endif
