%% SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
%% SPDX-License-Identifier: Apache-2.0

-module(hello_sup).
-behaviour(supervisor).

%% API
-export([start_link/0]).

%% Supervisor callbacks
-export([init/1]).

-define(SERVER, ?MODULE).

%% ===================================================================
%% API functions
%% ===================================================================

start_link() ->
    supervisor:start_link({local, ?SERVER}, ?MODULE, []).

%% ===================================================================
%% Supervisor callbacks
%% ===================================================================

init([]) ->
    RestartStrategy = one_for_one,
    MaxRestarts = 1000,
    MaxSecondsBetweenRestarts = 3600,

    SupFlags = {RestartStrategy, MaxRestarts, MaxSecondsBetweenRestarts},

    HelloServer = {hello_server,
                   {hello_server, start_link, []},
                   permanent,
                   2000,
                   worker,
                   [hello_server]},

    {ok, {SupFlags, [HelloServer]}}.
