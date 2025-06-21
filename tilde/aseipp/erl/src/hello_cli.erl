%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_cli).
-export([main/1]).

main([]) ->
    io:format("Hello from Erlang escript!~n"),
    io:format("Usage: hello_cli <command> [args]~n"),
    io:format("Commands:~n"),
    io:format("  greet <name>    - Greet someone~n"),
    io:format("  add <x> <y>     - Add two numbers~n"),
    io:format("  factorial <n>   - Calculate factorial~n"),
    halt(0);

main(["greet", Name]) ->
    hello_util:greet(Name),
    halt(0);

main(["add", X, Y]) ->
    try
        Num1 = list_to_integer(X),
        Num2 = list_to_integer(Y),
        Result = hello_util:add(Num1, Num2),
        io:format("~p + ~p = ~p~n", [Num1, Num2, Result]),
        halt(0)
    catch
        _:_ ->
            io:format("Error: Invalid numbers~n"),
            halt(1)
    end;

main(["factorial", N]) ->
    try
        Num = list_to_integer(N),
        Result = hello_util:factorial(Num),
        io:format("~p! = ~p~n", [Num, Result]),
        halt(0)
    catch
        _:_ ->
            io:format("Error: Invalid number~n"),
            halt(1)
    end;

main(_) ->
    io:format("Error: Invalid command~n"),
    main([]).
