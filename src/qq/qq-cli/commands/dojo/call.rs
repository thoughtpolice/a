// SPDX-FileCopyrightText: © 2024 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::io::Write;
use std::net::ToSocketAddrs;
use std::pin::Pin;

use capnp_rpc::{rpc_twoparty_capnp, twoparty, RpcSystem};
use futures::AsyncReadExt;
use jj_cli::{cli_util::CommandHelper, command_error::CommandError, ui::Ui};
use openssl::ssl::{SslConnector, SslMethod};
use tokio_openssl::SslStream;

// ---------------------------------------------------------------------------------------------------------------------

#[derive(clap::Args, Clone, Debug)]
pub(crate) struct CallArgs {
    #[arg(short, long, default_value = "42")]
    pub x: i32,
}

pub(crate) fn call_cmd(
    ui: &mut Ui,
    _command: &CommandHelper,
    args: CallArgs,
) -> Result<(), CommandError> {
    async fn run(
        ui: &mut Ui,
        args: CallArgs,
        addr: std::net::SocketAddr,
    ) -> Result<(), Box<dyn std::error::Error>> {
        tokio::task::LocalSet::new()
            .run_until(async move {
                let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
                connector.set_ca_file("buck-out/test/cert.pem").unwrap();
                let ssl = connector
                    .build()
                    .configure()
                    .unwrap()
                    .into_ssl("localhost")
                    .unwrap();

                let stream = tokio::net::TcpStream::connect(&addr).await?;
                stream.set_nodelay(true)?;

                let mut stream = SslStream::new(ssl, stream).unwrap();
                Pin::new(&mut stream).connect().await.unwrap();

                let (reader, writer) =
                    tokio_util::compat::TokioAsyncReadCompatExt::compat(stream).split();

                let rpc_network = Box::new(twoparty::VatNetwork::new(
                    futures::io::BufReader::new(reader),
                    futures::io::BufWriter::new(writer),
                    rpc_twoparty_capnp::Side::Client,
                    Default::default(),
                ));
                let mut rpc_system = RpcSystem::new(rpc_network, None);
                let test: qq_capnp::test::Client =
                    rpc_system.bootstrap(rpc_twoparty_capnp::Side::Server);

                tokio::task::spawn_local(rpc_system);

                let mut request = test.call_request();
                request.get().set_x(args.x);

                let reply = request.send().promise.await?;

                writeln!(ui.stdout(), "{}", reply.get()?.get_y())?;

                Ok(())
            })
            .await
    }

    let addr = "[::1]:9999".to_socket_addrs()?.next().unwrap();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run(ui, args, addr))
        .unwrap();
    Ok(())
}
