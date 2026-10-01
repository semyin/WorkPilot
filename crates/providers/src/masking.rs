/// Hold only a suffix that could be the start of a key. This prevents separate
/// stream fragments from writing an otherwise-redacted key into separate events.
#[derive(Default)]
pub struct Masker {
    pending: String,
}
impl Masker {
    pub fn push(&mut self, text: &str, secret: Option<&str>) -> String {
        let Some(secret) = secret.filter(|s| !s.is_empty()) else {
            return text.into();
        };
        self.pending.push_str(text);
        self.pending = self.pending.replace(secret, "[REDACTED]");
        let retained = secret
            .char_indices()
            .map(|(index, _)| index)
            .filter(|index| *index > 0 && self.pending.ends_with(&secret[..*index]))
            .max()
            .unwrap_or(0);
        let at = self.pending.len() - retained;
        let tail = self.pending.split_off(at);
        std::mem::replace(&mut self.pending, tail)
    }
    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_key_split_at_every_character_is_never_emitted() {
        let secret = "fake-测试-key";
        let mut masker = Masker::default();
        let mut emitted = String::new();
        for character in format!("hello {secret} world").chars() {
            emitted.push_str(&masker.push(&character.to_string(), Some(secret)));
        }
        emitted.push_str(&masker.finish());
        assert_eq!(emitted, "hello [REDACTED] world");
    }
}
