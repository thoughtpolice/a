%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_server).
-behaviour(gen_server).

%% API
-export([start_link/0, say_hello/0, get_count/0]).

%% gen_server callbacks
-export([init/1, handle_call/3, handle_cast/2, handle_info/2,
         terminate/2, code_change/3]).

-define(SERVER, ?MODULE).

-record(state, {counter = 0}).

%% ===================================================================
%% API
%% ===================================================================

start_link() ->
    gen_server:start_link({local, ?SERVER}, ?MODULE, [], []).

say_hello() ->
    gen_server:call(?SERVER, say_hello).

get_count() ->
    gen_server:call(?SERVER, get_count).

%% ===================================================================
%% gen_server callbacks
%% ===================================================================

init([]) ->
    {ok, #state{}}.

handle_call(say_hello, _From, State = #state{counter = Count}) ->
    io:format("Hello from Erlang! (call #~p)~n", [Count + 1]),
    {reply, ok, State#state{counter = Count + 1}};
handle_call(get_count, _From, State = #state{counter = Count}) ->
    {reply, Count, State};
handle_call(_Request, _From, State) ->
    {reply, ok, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.
