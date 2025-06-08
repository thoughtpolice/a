// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::net::ToSocketAddrs;
use std::pin::Pin;

use anyhow::Result;
use clap::Parser;
use futures::{AsyncReadExt, TryFutureExt};
use tracing::level_filters::LevelFilter;
use tracing_subscriber::{prelude::*, EnvFilter};

use capnp::capability::Promise;
use capnp_rpc::{pry, rpc_twoparty_capnp, twoparty, RpcSystem};
use openssl::ssl::{Ssl, SslAcceptor, SslFiletype, SslMethod};
use tokio_openssl::SslStream;

// ---------------------------------------------------------------------------------------------------------------------

#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser, Debug)]
#[command(name = "qq", author = "Austin Seipp", version = "0.1.0")]
struct Cli {}

#[tokio::main]
async fn main() -> Result<()> {
    let _cli = Cli::parse();

    let tokio_console_layer = console_subscriber::spawn();
    let cli_console_layer = tracing_subscriber::fmt::layer();

    let env_filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into()) /* XXX: change to error? */
        .with_env_var("QQ_LOG")
        .from_env_lossy();

    tracing_subscriber::registry()
        .with(tokio_console_layer)
        .with(cli_console_layer)
        .with(env_filter)
        //  .with(..potential additional layer..)
        .init();

    tracing::info!(message = "Starting qq-server");

    let addr = "[::1]:9999".to_socket_addrs()?.next().unwrap();
    tokio::task::LocalSet::new()
        .run_until(async move {
            let test: qq_capnp::test::Client = capnp_rpc::new_client(TestImpl);
            let listener = tokio::net::TcpListener::bind(&addr).await?;

            let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
            acceptor
                .set_private_key_file("buck-out/test/key.pem", SslFiletype::PEM)
                .unwrap();
            acceptor
                .set_certificate_chain_file("buck-out/test/cert.pem")
                .unwrap();
            let acceptor = acceptor.build();

            loop {
                let (stream, _) = listener.accept().await?;
                stream.set_nodelay(true)?;

                let ssl = Ssl::new(acceptor.context()).unwrap();
                let mut stream = SslStream::new(ssl, stream).unwrap();

                match Pin::new(&mut stream).accept().await {
                    Ok(_) => {}
                    Err(e) => {
                        tracing::error!(message = "error accepting SSL connection", e = ?e);
                        continue;
                    }
                }

                let (reader, writer) =
                    tokio_util::compat::TokioAsyncReadCompatExt::compat(stream).split();
                let network = twoparty::VatNetwork::new(
                    futures::io::BufReader::new(reader),
                    futures::io::BufWriter::new(writer),
                    rpc_twoparty_capnp::Side::Server,
                    Default::default(),
                );

                let rpc_system = RpcSystem::new(Box::new(network), Some(test.clone().client));
                tokio::task::spawn_local(rpc_system.map_err(|e| println!("error: {e:?}")));
            }
        })
        .await
}

// ---------------------------------------------------------------------------------------------------------------------

struct TestImpl;

impl qq_capnp::test::Server for TestImpl {
    fn call(
        &mut self,
        params: qq_capnp::test::CallParams,
        mut results: qq_capnp::test::CallResults,
    ) -> capnp::capability::Promise<(), capnp::Error> {
        let req = pry!(params.get());
        let x = req.get_x();
        tracing::info!(message = "got test call", x = x);
        let mut resp = results.get();
        resp.set_y(x + 42);

        Promise::ok(())
    }
}
