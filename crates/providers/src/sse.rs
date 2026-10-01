use crate::diagnostic::{Result, error};
use workpilot_contracts::ModelErrorCode;
pub const MAX_FRAME_BYTES: usize = 512 * 1024;
#[derive(Debug)]
pub struct Frame {
    pub event: String,
    pub data: String,
}
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    event: String,
    data: String,
    bytes: usize,
    after_cr: bool,
}
impl Decoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>> {
        let mut frames = vec![];
        for &byte in chunk {
            if self.after_cr && byte == b'\n' {
                self.after_cr = false;
                continue;
            }
            self.after_cr = byte == b'\r';
            self.bytes += 1;
            if self.bytes > MAX_FRAME_BYTES {
                return Err(error(ModelErrorCode::Limit));
            }
            if byte == b'\r' || byte == b'\n' {
                if self.line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop();
                        frames.push(Frame {
                            event: std::mem::take(&mut self.event),
                            data: std::mem::take(&mut self.data),
                        });
                    }
                    self.event.clear();
                    self.bytes = 0;
                } else {
                    let line = std::str::from_utf8(&self.line)
                        .map_err(|_| error(ModelErrorCode::MalformedStream))?
                        .trim_start_matches('\u{feff}');
                    if let Some(data) = line.strip_prefix("data:") {
                        self.data.push_str(data.strip_prefix(' ').unwrap_or(data));
                        self.data.push('\n');
                    }
                    if let Some(event) = line.strip_prefix("event:") {
                        self.event = event.trim().into();
                    }
                    self.line.clear();
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(frames)
    }
}
