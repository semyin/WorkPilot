//! Native messaging relay. The one-use code selects an authenticated loopback session.
//! No browser profile, filesystem, shell or model credentials are exposed.
use serde_json::Value;
use std::{
    io::{self, BufRead, Read, Write},
    net::{Shutdown, TcpStream},
    time::Duration,
};
const MAX_INPUT: usize = 12 * 1024 * 1024;
fn read_native(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut n = [0; 4];
    reader.read_exact(&mut n)?;
    let n = u32::from_le_bytes(n) as usize;
    if n == 0 || n > MAX_INPUT {
        return Err(io::Error::other("native message exceeds limit"));
    }
    let mut data = vec![0; n];
    reader.read_exact(&mut data)?;
    Ok(data)
}
fn write_native(writer: &mut impl Write, data: &[u8]) -> io::Result<()> {
    if data.len() > 1024 * 1024 {
        return Err(io::Error::other("extension message exceeds limit"));
    }
    writer.write_all(&(data.len() as u32).to_le_bytes())?;
    writer.write_all(data)?;
    writer.flush()
}
fn serve() -> io::Result<()> {
    let origin = std::env::args().nth(1).unwrap_or_default();
    let expected = format!(
        "chrome-extension://{}/",
        include_str!("../../../../extensions/companion/extension-id.txt").trim()
    );
    if origin != expected {
        return Err(io::Error::other("unexpected extension origin"));
    }
    let mut input = io::stdin().lock();
    let first = read_native(&mut input)?;
    let value: Value = serde_json::from_slice(&first)?;
    let token = value["token"]
        .as_str()
        .ok_or_else(|| io::Error::other("missing pairing code"))?;
    let (port, secret) = token
        .split_once('-')
        .ok_or_else(|| io::Error::other("invalid pairing code"))?;
    if value["kind"] != "pair"
        || secret.len() != 48
        || !secret.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(io::Error::other("invalid pairing code"));
    }
    let port: u16 = port.parse().map_err(|_| io::Error::other("invalid port"))?;
    if port < 1024 {
        return Err(io::Error::other("invalid port"));
    }
    let mut socket = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(3),
    )?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    socket.write_all(&first)?;
    socket.write_all(b"\n")?;
    let mut sender = socket.try_clone()?;
    std::thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut input = io::stdin().lock();
            loop {
                let bytes = read_native(&mut input)?;
                sender.write_all(&bytes)?;
                sender.write_all(b"\n")?;
            }
        })();
        let _ = result;
        let _ = sender.shutdown(Shutdown::Both);
    });
    // Release the initial stdin lock before the forwarding thread acquires it.
    drop(input);
    let mut reader = io::BufReader::new(socket);
    let mut output = io::stdout().lock();
    loop {
        let mut bytes = vec![];
        let size = (&mut reader)
            .take(1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)?;
        if size == 0 {
            return Ok(());
        }
        if bytes.last() != Some(&b'\n') {
            return Err(io::Error::other("invalid host message"));
        }
        bytes.pop();
        write_native(&mut output, &bytes)?;
    }
}
fn main() {
    if serve().is_err() {
        eprintln!(
            "WorkPilot browser connection ended. Check the local host registration and pairing code."
        );
        std::process::exit(1);
    }
}
