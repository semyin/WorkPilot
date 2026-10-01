//! Chrome/Edge native-messaging transport probe.
//! No filesystem, shell, arbitrary evaluation, or model access is exposed.
use serde_json::{Value, json};
use std::io::{self, Read, Write};
const MAX_MESSAGE: usize = 65_536;

fn reply(message: &Value) -> Value {
    let id = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| id.len() <= 128);
    match message.get("kind").and_then(Value::as_str) {
        Some("hello") => {
            json!({"id":id,"kind":"hello","protocol":"workpilot.browser-probe.v1","pid":std::process::id(),"version":env!("CARGO_PKG_VERSION")})
        }
        Some("probe") => {
            json!({"id":id,"kind":"probe","action":"fill_click_read","name":"WorkPilot","fixture_path":"/page","fixture_title":"WorkPilot Browser Fixture"})
        }
        Some("result") => json!({"id":id,"kind":"ack"}),
        Some("disconnect") => json!({"id":id,"kind":"bye"}),
        _ => json!({"id":id,"kind":"error","message":"Unsupported probe command"}),
    }
}
fn serve(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    loop {
        let mut length = [0u8; 4];
        match input.read_exact(&mut length) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        }
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_MESSAGE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native message exceeds the 64 KiB probe limit",
            ));
        }
        let mut bytes = vec![0u8; length];
        input.read_exact(&mut bytes)?;
        let message: Value = serde_json::from_slice(&bytes)?;
        let response = serde_json::to_vec(&reply(&message))?;
        output.write_all(&(response.len() as u32).to_le_bytes())?;
        output.write_all(&response)?;
        output.flush()?;
        if message.get("kind").and_then(Value::as_str) == Some("disconnect") {
            return Ok(());
        }
    }
}
fn main() {
    // stdout must contain framing only; diagnostics go to stderr.
    if let Err(error) = serve(io::stdin().lock(), io::stdout().lock()) {
        eprintln!("WorkPilot browser probe: {error}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(value: Value) -> Vec<u8> {
        let body = serde_json::to_vec(&value).unwrap();
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend(body);
        bytes
    }
    #[test]
    fn native_transport_handles_multiple_messages_and_disconnect() {
        let mut input = frame(json!({"id":"1","kind":"hello"}));
        input.extend(frame(json!({"id":"2","kind":"probe"})));
        input.extend(frame(json!({"id":"3","kind":"disconnect"})));
        input.extend(frame(json!({"id":"4","kind":"probe"})));
        let mut output = Vec::new();
        serve(input.as_slice(), &mut output).unwrap();
        let mut cursor = io::Cursor::new(output);
        let mut messages = Vec::new();
        while (cursor.position() as usize) < cursor.get_ref().len() {
            let mut length = [0; 4];
            cursor.read_exact(&mut length).unwrap();
            let mut bytes = vec![0; u32::from_le_bytes(length) as usize];
            cursor.read_exact(&mut bytes).unwrap();
            messages.push(serde_json::from_slice::<Value>(&bytes).unwrap());
        }
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["kind"], "hello");
        assert_eq!(messages[1]["action"], "fill_click_read");
        assert_eq!(messages[2]["kind"], "bye");
    }
    #[test]
    fn rejects_oversized_messages_and_unknown_commands() {
        assert!(
            serve(
                (MAX_MESSAGE as u32 + 1).to_le_bytes().as_slice(),
                Vec::new()
            )
            .is_err()
        );
        assert_eq!(
            reply(&json!({"kind":"execute","command":"anything"}))["kind"],
            "error"
        );
    }
}
