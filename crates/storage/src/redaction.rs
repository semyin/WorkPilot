//! Applied before disk or transport writes. Unknown secrets cannot be inferred;
//! providers must register credentials before processing responses.
use serde_json::Value;

#[derive(Default, Clone)]
pub struct Redactor {
    secrets: Vec<String>,
}
impl Redactor {
    pub fn contains_registered_secret(&self, text: &str) -> bool {
        self.secrets.iter().any(|secret| text.contains(secret))
    }
    pub fn register(&mut self, secret: &str) -> crate::Result<()> {
        if secret.is_empty() || secret.len() > 4096 || secret.chars().any(char::is_control) {
            return Err(crate::Error::Invalid("credential length"));
        }
        if !self.secrets.iter().any(|s| s == secret) {
            self.secrets.push(secret.to_owned());
        }
        self.secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Ok(())
    }
    pub fn text(&self, input: &str) -> String {
        let mut text = input.to_owned();
        for secret in &self.secrets {
            text = text.replace(secret, "[REDACTED]");
        }
        text.split_inclusive('\n')
            .map(|line| {
                let lower = line.to_ascii_lowercase();
                if [
                    "authorization:",
                    "authorization\"",
                    "x-api-key",
                    "api_key",
                    "api-key",
                    "access_token",
                    "refresh_token",
                    "password",
                    "set-cookie:",
                    "cookie:",
                    "bearer ",
                ]
                .iter()
                .any(|key| lower.contains(key))
                {
                    if line.ends_with('\n') {
                        "[REDACTED AUTHENTICATION DATA]\n".into()
                    } else {
                        "[REDACTED AUTHENTICATION DATA]".into()
                    }
                } else {
                    line.to_owned()
                }
            })
            .collect()
    }
    pub fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|v| self.value(v)),
            Value::Object(map) => {
                for (key, value) in map {
                    let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                    // A typed authentication-mode identifier is not a credential.
                    // Keep the finite enum while still redacting actual auth values.
                    if key == "auth"
                        && matches!(value.as_str(), Some("auto" | "bearer" | "api_key" | "none"))
                        && !self
                            .secrets
                            .iter()
                            .any(|s| Some(s.as_str()) == value.as_str())
                    {
                        continue;
                    }
                    if [
                        "authorization",
                        "apikey",
                        "accesstoken",
                        "refreshtoken",
                        "password",
                        "cookie",
                        "setcookie",
                        "secret",
                    ]
                    .contains(&key.as_str())
                    {
                        *value = Value::String("[REDACTED]".into());
                    } else {
                        self.value(value);
                    }
                }
            }
            _ => {}
        }
    }
}
