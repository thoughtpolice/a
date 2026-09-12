{
  description = "cs2wasm .NET 11 development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          dotnetSdk = pkgs.dotnetCorePackages.sdk_11_0;
          dotnetTraceVersion = "10.0.731102";
          # This version is published to the dotnet-tools feed, not nuget.org.
          dotnetTraceNupkg = pkgs.dotnetCorePackages.fetchNupkg {
            pname = "dotnet-trace";
            version = dotnetTraceVersion;
            url = "https://pkgs.dev.azure.com/dnceng/public/_packaging/dotnet-tools/nuget/v3/flat2/dotnet-trace/${dotnetTraceVersion}/dotnet-trace.${dotnetTraceVersion}.nupkg";
            hash = "sha256-BrnJ73Amfab5I92L6eGnV9acmANq+mtRVgTec1vt8K4=";
            installable = true;
          };
          dotnetTrace =
            (pkgs.dotnetCorePackages.buildDotnetGlobalTool {
              pname = "dotnet-trace";
              version = dotnetTraceVersion;
              # The nuget.org fetch is replaced with dotnetTraceNupkg below.
              nugetHash = nixpkgs.lib.fakeHash;
              executables = [ "dotnet-trace" ];
              dotnet-sdk = dotnetSdk;
              dotnet-runtime = dotnetSdk.runtime;
            }).overrideAttrs
              (_: {
                buildInputs = [ dotnetTraceNupkg ];
              });
          dotnetShell = pkgs.mkShell {
            name = "cs2wasm-dev";
            packages = [
              dotnetSdk
              dotnetTrace
              pkgs.nodejs
              pkgs.wasm-tools
              pkgs.wasmtime
              pkgs.wabt
              pkgs.binaryen
              pkgs.spidermonkey_140
            ];
          };
        in
        {
          default = dotnetShell;
          dotnet = dotnetShell;
        }
      );
    };
}
