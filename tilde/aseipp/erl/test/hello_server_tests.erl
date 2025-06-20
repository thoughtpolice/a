%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_server_tests).
-include_lib("eunit/include/eunit.hrl").

hello_server_test_() ->
    {setup,
     fun setup/0,
     fun cleanup/1,
     [
      fun test_say_hello/0,
      fun test_get_count/0,
      fun test_multiple_hellos/0
     ]}.

setup() ->
    {ok, Pid} = hello_server:start_link(),
    Pid.

cleanup(Pid) ->
    exit(Pid, normal).

test_say_hello() ->
    ?assertEqual(ok, hello_server:say_hello()).

test_get_count() ->
    Initial = hello_server:get_count(),
    hello_server:say_hello(),
    ?assertEqual(Initial + 1, hello_server:get_count()).

test_multiple_hellos() ->
    Initial = hello_server:get_count(),
    hello_server:say_hello(),
    hello_server:say_hello(),
    hello_server:say_hello(),
    ?assertEqual(Initial + 3, hello_server:get_count()).
