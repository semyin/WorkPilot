//! OS credential storage. No plaintext or in-memory fallback when unavailable.
use workpilot_contracts::{CredentialRef, valid_id};
use zeroize::Zeroizing;

pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: String) -> Result<Self, CredentialError> {
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(CredentialError::Invalid);
        }
        Ok(Self(Zeroizing::new(value)))
    }
    /// Callers must register this value with the log redactor before any use.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}
impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret([REDACTED])")
    }
}
#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("invalid credential reference or secret")]
    Invalid,
    #[error("system credential store is unavailable or locked")]
    Unavailable,
    #[error("credential is not configured")]
    NotFound,
}
pub trait CredentialStore {
    fn put(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError>;
    fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError>;
}
pub struct SystemCredentials {
    service: String,
}
impl SystemCredentials {
    pub fn new(channel: &str) -> Result<Self, CredentialError> {
        if !valid_id(channel) {
            return Err(CredentialError::Invalid);
        }
        Ok(Self {
            service: format!("com.workpilot.{channel}"),
        })
    }
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn entry(&self, reference: &CredentialRef) -> Result<keyring::Entry, CredentialError> {
        if !valid_id(&reference.id) {
            return Err(CredentialError::Invalid);
        }
        keyring::Entry::new(&self.service, &reference.id).map_err(|_| CredentialError::Unavailable)
    }
}
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl CredentialStore for SystemCredentials {
    fn put(&self, reference: &CredentialRef, secret: &Secret) -> Result<(), CredentialError> {
        self.entry(reference)?
            .set_password(secret.expose())
            .map_err(|_| CredentialError::Unavailable)
    }
    fn get(&self, reference: &CredentialRef) -> Result<Secret, CredentialError> {
        let value = self
            .entry(reference)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => CredentialError::NotFound,
                _ => CredentialError::Unavailable,
            })?;
        Secret::new(value)
    }
    fn delete(&self, reference: &CredentialRef) -> Result<(), CredentialError> {
        match self.entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
impl CredentialStore for SystemCredentials {
    fn put(&self, _: &CredentialRef, _: &Secret) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
    fn get(&self, _: &CredentialRef) -> Result<Secret, CredentialError> {
        Err(CredentialError::Unavailable)
    }
    fn delete(&self, _: &CredentialRef) -> Result<(), CredentialError> {
        Err(CredentialError::Unavailable)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secret_debug_never_shows_value() {
        let value = Secret::new("synthetic-never-real-key".into()).unwrap();
        assert_eq!(format!("{value:?}"), "Secret([REDACTED])");
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "writes and removes an isolated synthetic credential in Windows Credential Manager"]
    fn windows_credential_roundtrip() {
        let key = format!(
            "p01-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let reference = CredentialRef { id: key.clone() };
        let store = SystemCredentials::new(&key).unwrap();
        let secret = Secret::new("workpilot-synthetic-credential-only".into()).unwrap();
        store.put(&reference, &secret).unwrap();
        let actual = store.get(&reference);
        // Cleanup precedes assertions; no real account entries are read or changed.
        let deleted = store.delete(&reference);
        assert!(actual.is_ok());
        assert!(actual.unwrap().expose() == secret.expose());
        deleted.unwrap();
        assert!(matches!(
            store.get(&reference),
            Err(CredentialError::NotFound)
        ));
    }
}
