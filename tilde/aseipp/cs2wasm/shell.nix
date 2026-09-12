let
  flake = builtins.getFlake "path:${toString ./.}";
in
flake.devShells.${builtins.currentSystem}.default
