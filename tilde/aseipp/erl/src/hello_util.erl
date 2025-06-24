%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_util).

%% API
-export([greet/1, add/2, factorial/1]).

%% ===================================================================
%% API
%% ===================================================================

greet(Name) ->
    io:format("Hello, ~s!~n", [Name]),
    {ok, greeted}.

add(X, Y) ->
    X + Y.

factorial(0) -> 1;
factorial(N) when N > 0 ->
    N * factorial(N - 1).
