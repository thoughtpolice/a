%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_util_tests).
-include_lib("eunit/include/eunit.hrl").

add_test() ->
    ?assertEqual(5, hello_util:add(2, 3)),
    ?assertEqual(0, hello_util:add(-5, 5)),
    ?assertEqual(-10, hello_util:add(-4, -6)).

factorial_test() ->
    ?assertEqual(1, hello_util:factorial(0)),
    ?assertEqual(1, hello_util:factorial(1)),
    ?assertEqual(2, hello_util:factorial(2)),
    ?assertEqual(6, hello_util:factorial(3)),
    ?assertEqual(24, hello_util:factorial(4)),
    ?assertEqual(120, hello_util:factorial(5)).

greet_test() ->
    ?assertEqual({ok, greeted}, hello_util:greet("World")),
    ?assertEqual({ok, greeted}, hello_util:greet("Erlang")).
