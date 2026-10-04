use crate::vault::Result;
use futures_util::StreamExt;
use std::time::Duration;

const LIMIT: usize = 32 * 1024 * 1024;

pub fn result_url(raw: &str, service: &str) -> Result<url::Url> {
    if raw.len() > 8192 {
        return Err("图片下载地址过长 / Image download URL is too long".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "图片下载地址无效 / Invalid image download URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("图片下载地址不能包含账户或片段 / Unsupported image download URL".into());
    }
    let base = super::images::base_url(service)?;
    let local = base.scheme() == "http"
        && matches!(
            base.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        )
        && url.origin() == base.origin();
    let official = url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            host.split_once(".oss-").is_some_and(|(bucket, domain)| {
                !bucket.is_empty()
                    && !bucket.contains('.')
                    && domain.strip_suffix(".aliyuncs.com").is_some_and(|region| {
                        !region.is_empty()
                            && region
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    })
            })
        });
    if !local && !official {
        return Err("百炼图片仅下载官方 HTTPS OSS 地址；本机测试仅允许同源 / Only official HTTPS OSS image URLs or the configured local origin are allowed".into());
    }
    Ok(url)
}

pub async fn download(client: &reqwest::Client, raw: &str, service: &str) -> Result<Vec<u8>> {
    let url = result_url(raw, service)?;
    // Do not forward the model service Authorization header to object storage.
    // The client has no default credentials, redirects or automatic retries.
    let response = client
        .get(url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| "图片文件下载失败；不会自动重试 / Image download failed; no retry")?;
    if !response.status().is_success() {
        return Err(format!(
            "图片文件下载被拒绝 / Image download rejected ({}); no retry",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("图片超过 32 MiB / Image exceeds limit".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "图片下载中断 / Image download interrupted; no retry")?;
        if bytes.len() + chunk.len() > LIMIT {
            return Err("图片超过 32 MiB / Image exceeds limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("图片文件为空 / Empty image".into());
    }
    // Format, dimensions and decodability are checked by the existing media worker
    // before an operation can write its versioned project output.
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_oss_is_allowed_but_credentials_ports_private_hosts_and_redirect_targets_are_not() {
        let base = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
        assert!(result_url("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/a.png?Expires=123&Signature=synthetic", base).is_ok());
        for rejected in [
            "http://bucket.oss-cn-beijing.aliyuncs.com/a.png",
            "https://bucket.oss-cn-beijing.aliyuncs.com:8443/a.png",
            "https://bucket.oss-cn-beijing.aliyuncs.com.evil.example/a.png",
            "https://bucket.oss-evil.example.aliyuncs.com/a.png",
            "https://user:password@bucket.oss-cn-beijing.aliyuncs.com/a.png",
            "https://127.0.0.1/a.png",
            "https://169.254.169.254/latest/meta-data",
            "file:///C:/private.png",
        ] {
            assert!(result_url(rejected, base).is_err(), "{rejected}");
        }
    }

    #[test]
    fn local_fixture_urls_cannot_cross_scheme_host_or_port() {
        let base = "http://127.0.0.1:1234/v1";
        assert!(result_url("http://127.0.0.1:1234/image.png", base).is_ok());
        for rejected in [
            "http://127.0.0.1:1235/image.png",
            "http://localhost:1234/image.png",
            "http://10.0.0.1/image.png",
            "https://127.0.0.1:1234/image.png",
        ] {
            assert!(result_url(rejected, base).is_err());
        }
    }
}
