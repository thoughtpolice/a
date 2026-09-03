// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The traits the containers and the guests built on them ask about a type.
// The ones that need to see inside a class are the compiler's own builtins,
// which is the only way any implementation answers them.

#ifndef CONSOLE_CXX_TYPE_TRAITS
#define CONSOLE_CXX_TYPE_TRAITS

#include <stddef.h>

namespace std {

template <typename T, T Value>
struct integral_constant {
    static constexpr T value = Value;
    using value_type = T;
    using type = integral_constant;
    constexpr operator value_type() const noexcept { return value; }
    constexpr value_type operator()() const noexcept { return value; }
};

template <bool Value>
using bool_constant = integral_constant<bool, Value>;

using true_type = bool_constant<true>;
using false_type = bool_constant<false>;

template <bool Condition, typename T = void>
struct enable_if {};

template <typename T>
struct enable_if<true, T> {
    using type = T;
};

template <bool Condition, typename T = void>
using enable_if_t = typename enable_if<Condition, T>::type;

template <bool Condition, typename Then, typename Else>
struct conditional {
    using type = Then;
};

template <typename Then, typename Else>
struct conditional<false, Then, Else> {
    using type = Else;
};

template <bool Condition, typename Then, typename Else>
using conditional_t = typename conditional<Condition, Then, Else>::type;

template <typename...>
using void_t = void;

template <typename T, typename U>
struct is_same : false_type {};
template <typename T>
struct is_same<T, T> : true_type {};
template <typename T, typename U>
inline constexpr bool is_same_v = is_same<T, U>::value;

// --- Stripping and adding ---------------------------------------------------

template <typename T> struct remove_const { using type = T; };
template <typename T> struct remove_const<const T> { using type = T; };
template <typename T> using remove_const_t = typename remove_const<T>::type;

template <typename T> struct remove_volatile { using type = T; };
template <typename T> struct remove_volatile<volatile T> { using type = T; };
template <typename T> using remove_volatile_t = typename remove_volatile<T>::type;

template <typename T>
struct remove_cv {
    using type = remove_volatile_t<remove_const_t<T>>;
};
template <typename T> using remove_cv_t = typename remove_cv<T>::type;

template <typename T> struct add_const { using type = const T; };
template <typename T> using add_const_t = typename add_const<T>::type;

template <typename T> struct remove_reference { using type = T; };
template <typename T> struct remove_reference<T&> { using type = T; };
template <typename T> struct remove_reference<T&&> { using type = T; };
template <typename T> using remove_reference_t = typename remove_reference<T>::type;

template <typename T> struct remove_pointer { using type = T; };
template <typename T> struct remove_pointer<T*> { using type = T; };
template <typename T> struct remove_pointer<T* const> { using type = T; };
template <typename T> struct remove_pointer<T* volatile> { using type = T; };
template <typename T> struct remove_pointer<T* const volatile> { using type = T; };
template <typename T> using remove_pointer_t = typename remove_pointer<T>::type;

template <typename T> struct remove_extent { using type = T; };
template <typename T> struct remove_extent<T[]> { using type = T; };
template <typename T, size_t N> struct remove_extent<T[N]> { using type = T; };
template <typename T> using remove_extent_t = typename remove_extent<T>::type;

template <typename T>
struct type_identity {
    using type = T;
};

// void and a function type have no reference to add, and picking the variadic
// overload for them is what makes that the identity rather than an error.
namespace __console {

template <typename T>
auto add_lvalue(int) -> type_identity<T&>;
template <typename T>
auto add_lvalue(...) -> type_identity<T>;

template <typename T>
auto add_rvalue(int) -> type_identity<T&&>;
template <typename T>
auto add_rvalue(...) -> type_identity<T>;

}  // namespace __console

template <typename T>
struct add_lvalue_reference : decltype(__console::add_lvalue<T>(0)) {};
template <typename T>
using add_lvalue_reference_t = typename add_lvalue_reference<T>::type;

template <typename T>
struct add_rvalue_reference : decltype(__console::add_rvalue<T>(0)) {};
template <typename T>
using add_rvalue_reference_t = typename add_rvalue_reference<T>::type;

// Names a value of the type in an unevaluated operand, so a trait can ask
// what an expression over it would do without anything being constructed.
template <typename T>
add_rvalue_reference_t<T> declval() noexcept;

// --- What a type is ---------------------------------------------------------

template <typename T> struct is_void : is_same<void, remove_cv_t<T>> {};
template <typename T> inline constexpr bool is_void_v = is_void<T>::value;

template <typename T> struct is_const : false_type {};
template <typename T> struct is_const<const T> : true_type {};
template <typename T> inline constexpr bool is_const_v = is_const<T>::value;

template <typename T> struct is_volatile : false_type {};
template <typename T> struct is_volatile<volatile T> : true_type {};

template <typename T> struct is_lvalue_reference : false_type {};
template <typename T> struct is_lvalue_reference<T&> : true_type {};
template <typename T>
inline constexpr bool is_lvalue_reference_v = is_lvalue_reference<T>::value;

template <typename T> struct is_rvalue_reference : false_type {};
template <typename T> struct is_rvalue_reference<T&&> : true_type {};

template <typename T> struct is_reference : false_type {};
template <typename T> struct is_reference<T&> : true_type {};
template <typename T> struct is_reference<T&&> : true_type {};
template <typename T> inline constexpr bool is_reference_v = is_reference<T>::value;

template <typename T> struct is_array : false_type {};
template <typename T> struct is_array<T[]> : true_type {};
template <typename T, size_t N> struct is_array<T[N]> : true_type {};
template <typename T> inline constexpr bool is_array_v = is_array<T>::value;

namespace __console {

template <typename T> struct is_pointer_impl : false_type {};
template <typename T> struct is_pointer_impl<T*> : true_type {};

template <typename T> struct is_integral_impl : false_type {};
template <> struct is_integral_impl<bool> : true_type {};
template <> struct is_integral_impl<char> : true_type {};
template <> struct is_integral_impl<signed char> : true_type {};
template <> struct is_integral_impl<unsigned char> : true_type {};
template <> struct is_integral_impl<wchar_t> : true_type {};
template <> struct is_integral_impl<char16_t> : true_type {};
template <> struct is_integral_impl<char32_t> : true_type {};
template <> struct is_integral_impl<short> : true_type {};
template <> struct is_integral_impl<unsigned short> : true_type {};
template <> struct is_integral_impl<int> : true_type {};
template <> struct is_integral_impl<unsigned int> : true_type {};
template <> struct is_integral_impl<long> : true_type {};
template <> struct is_integral_impl<unsigned long> : true_type {};
template <> struct is_integral_impl<long long> : true_type {};
template <> struct is_integral_impl<unsigned long long> : true_type {};

template <typename T> struct is_floating_point_impl : false_type {};
template <> struct is_floating_point_impl<float> : true_type {};
template <> struct is_floating_point_impl<double> : true_type {};
template <> struct is_floating_point_impl<long double> : true_type {};

}  // namespace __console

template <typename T>
struct is_pointer : __console::is_pointer_impl<remove_cv_t<T>> {};
template <typename T> inline constexpr bool is_pointer_v = is_pointer<T>::value;

template <typename T>
struct is_integral : __console::is_integral_impl<remove_cv_t<T>> {};
template <typename T> inline constexpr bool is_integral_v = is_integral<T>::value;

template <typename T>
struct is_floating_point : __console::is_floating_point_impl<remove_cv_t<T>> {};
template <typename T>
inline constexpr bool is_floating_point_v = is_floating_point<T>::value;

template <typename T>
struct is_arithmetic : bool_constant<is_integral<T>::value || is_floating_point<T>::value> {};
template <typename T> inline constexpr bool is_arithmetic_v = is_arithmetic<T>::value;

template <typename T> struct is_enum : bool_constant<__is_enum(T)> {};
template <typename T> inline constexpr bool is_enum_v = is_enum<T>::value;

template <typename T> struct is_class : bool_constant<__is_class(T)> {};
template <typename T> inline constexpr bool is_class_v = is_class<T>::value;

template <typename T> struct is_union : bool_constant<__is_union(T)> {};

template <typename T>
struct is_function
    : bool_constant<!is_const_v<const T> && !is_reference_v<T>> {};
template <typename T> inline constexpr bool is_function_v = is_function<T>::value;

template <typename Base, typename Derived>
struct is_base_of : bool_constant<__is_base_of(Base, Derived)> {};
template <typename Base, typename Derived>
inline constexpr bool is_base_of_v = is_base_of<Base, Derived>::value;

template <typename From, typename To>
struct is_convertible : bool_constant<__is_convertible_to(From, To)> {};
template <typename From, typename To>
inline constexpr bool is_convertible_v = is_convertible<From, To>::value;

// --- What can be done with a type -------------------------------------------

template <typename T, typename... Args>
struct is_constructible : bool_constant<__is_constructible(T, Args...)> {};
template <typename T, typename... Args>
inline constexpr bool is_constructible_v = is_constructible<T, Args...>::value;

template <typename T>
struct is_default_constructible : is_constructible<T> {};

template <typename T>
struct is_copy_constructible : is_constructible<T, add_lvalue_reference_t<const T>> {};
template <typename T>
inline constexpr bool is_copy_constructible_v = is_copy_constructible<T>::value;

template <typename T>
struct is_move_constructible : is_constructible<T, add_rvalue_reference_t<T>> {};
template <typename T>
inline constexpr bool is_move_constructible_v = is_move_constructible<T>::value;

template <typename To, typename From>
struct is_assignable : bool_constant<__is_assignable(To, From)> {};

template <typename T>
struct is_copy_assignable
    : is_assignable<add_lvalue_reference_t<T>, add_lvalue_reference_t<const T>> {};

template <typename T>
struct is_move_assignable
    : is_assignable<add_lvalue_reference_t<T>, add_rvalue_reference_t<T>> {};

template <typename T>
struct is_destructible : bool_constant<__is_destructible(T)> {};

template <typename T, typename... Args>
struct is_nothrow_constructible : bool_constant<__is_nothrow_constructible(T, Args...)> {};

template <typename T>
struct is_nothrow_move_constructible
    : is_nothrow_constructible<T, add_rvalue_reference_t<T>> {};
template <typename T>
inline constexpr bool is_nothrow_move_constructible_v =
    is_nothrow_move_constructible<T>::value;

template <typename To, typename From>
struct is_nothrow_assignable : bool_constant<__is_nothrow_assignable(To, From)> {};

template <typename T>
struct is_nothrow_move_assignable
    : is_nothrow_assignable<add_lvalue_reference_t<T>, add_rvalue_reference_t<T>> {};

template <typename T, typename... Args>
struct is_trivially_constructible : bool_constant<__is_trivially_constructible(T, Args...)> {};

template <typename T>
struct is_trivially_copy_constructible
    : is_trivially_constructible<T, add_lvalue_reference_t<const T>> {};

template <typename T>
struct is_trivially_move_constructible
    : is_trivially_constructible<T, add_rvalue_reference_t<T>> {};

template <typename T>
struct is_trivially_destructible : bool_constant<__is_trivially_destructible(T)> {};
template <typename T>
inline constexpr bool is_trivially_destructible_v = is_trivially_destructible<T>::value;

template <typename T>
struct is_trivially_copyable : bool_constant<__is_trivially_copyable(T)> {};
template <typename T>
inline constexpr bool is_trivially_copyable_v = is_trivially_copyable<T>::value;

template <typename T>
struct alignment_of : integral_constant<size_t, alignof(T)> {};

// The type a by-value parameter would have: arrays and functions become
// pointers, and everything else loses its reference and its qualifiers.
template <typename T>
struct decay {
private:
    using bare = remove_reference_t<T>;

public:
    using type = conditional_t<
        is_array<bare>::value, remove_extent_t<bare>*,
        conditional_t<is_function<bare>::value, bare*, remove_cv_t<bare>>>;
};
template <typename T> using decay_t = typename decay<T>::type;

}  // namespace std

#endif
