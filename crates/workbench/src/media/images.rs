use crate::vault::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use workpilot_contracts::{ImageProtocol, ImageRequest, ImageService};
use workpilot_platform::credentials::Secret;
pub struct ImageOutput {
    pub images: Vec<Vec<u8>>,
    pub usage: Value,
    pub revised_prompts: Vec<Value>,
}
pub fn base_url(raw: &str) -> Result<url::Url> {
    let mut url =
        url::Url::parse(raw).map_err(|_| "图片服务地址无效 / Invalid image service URL")?;
    let local = url
        .host_str()
        .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "::1" | "[::1]"));
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("图片服务需使用 HTTPS（本机允许 HTTP），地址不能含凭据 / Use HTTPS or loopback HTTP without credentials in URL".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
pub fn validate_request(service: &ImageService, request: &ImageRequest) -> Result<()> {
    if service.revision != request.service_revision {
        return Err("图片配置已改变，请刷新后重新确认 / Image configuration changed".into());
    }
    if service.auth_required && service.credential.is_none() {
        return Err("图片服务尚未填写密钥 / Image service key is missing".into());
    }
    if service.protocol == ImageProtocol::AliyunImages
        && (request.format != "png"
            || request.quality.is_some()
            || service.model.starts_with("qwen-image-3.0") && request.references.len() > 3)
    {
        return Err("百炼图像适配输出 PNG，不发送 quality；Qwen Image 3.0 最多 3 张参考图 / Bailian uses PNG without quality; Qwen Image 3.0 accepts at most 3 references".into());
    }
    if !service.sizes.contains(&request.size)
        || request
            .quality
            .as_ref()
            .is_some_and(|q| !service.qualities.contains(q))
        || !service.formats.contains(&request.format)
        || request.count > service.max_count
        || !request.references.is_empty() && !service.supports_edit
    {
        return Err(
            "图片参数不在此配置支持的范围内 / Unsupported parameters for this image service".into(),
        );
    }
    if request.size != "auto" {
        let parts = request
            .size
            .split('x')
            .map(str::parse::<u32>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "Invalid image size")?;
        if parts.len() != 2
            || parts[0] == 0
            || parts[1] == 0
            || u64::from(parts[0]) * u64::from(parts[1]) > 32 * 1024 * 1024
        {
            return Err("Invalid image size".into());
        }
    }
    for path in &request.paths {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|s| s.to_str());
        if ext != Some(request.format.as_str()) && !(request.format == "jpeg" && ext == Some("jpg"))
        {
            return Err(
                "图片文件扩展名与输出格式不一致 / Image extension does not match output format"
                    .into(),
            );
        }
    }
    base_url(&service.base_url)?;
    Ok(())
}
async fn stopped(stop: Arc<AtomicBool>) {
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}
pub async fn generate(
    service: &ImageService,
    secret: Option<&Secret>,
    request: &ImageRequest,
    references: Vec<(String, String, Vec<u8>)>,
    stop: Arc<AtomicBool>,
) -> Result<ImageOutput> {
    if stop.load(Ordering::SeqCst) {
        return Err("图片生成已停止 / Image generation stopped".into());
    }
    let aliyun = service.protocol == ImageProtocol::AliyunImages;
    let timeout = Duration::from_secs(if aliyun { 600 } else { 180 });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let url = base_url(&service.base_url)?
        .join(if references.is_empty() || aliyun {
            "images/generations"
        } else {
            "images/edits"
        })
        .map_err(|e| e.to_string())?;
    let mut call = client.post(url);
    if let Some(secret) = secret {
        call = call.bearer_auth(secret.expose());
    }
    if aliyun {
        let mut body = json!({"model":service.model,"prompt":request.prompt,"size":request.size,"n":request.count});
        if !references.is_empty() {
            body["image"] = json!(
                references
                    .iter()
                    .map(|(_, media, bytes)| {
                        format!("data:{media};base64,{}", STANDARD.encode(bytes))
                    })
                    .collect::<Vec<_>>()
            );
        }
        call = call.json(&body);
    } else if references.is_empty() {
        let mut body = json!({"model":service.model,"prompt":request.prompt,"size":request.size,"n":request.count,"output_format":request.format});
        if let Some(q) = &request.quality {
            body["quality"] = json!(q);
        }
        if service.request_base64 {
            body["response_format"] = json!("b64_json");
        }
        call = call.json(&body);
    } else {
        let mut form = reqwest::multipart::Form::new()
            .text("model", service.model.clone())
            .text("prompt", request.prompt.clone())
            .text("size", request.size.clone())
            .text("n", request.count.to_string())
            .text("output_format", request.format.clone());
        if let Some(q) = &request.quality {
            form = form.text("quality", q.clone());
        }
        if service.request_base64 {
            form = form.text("response_format", "b64_json");
        }
        for (name, media, bytes) in references {
            form = form.part(
                "image[]",
                reqwest::multipart::Part::bytes(bytes)
                    .file_name(name)
                    .mime_str(&media)
                    .map_err(|e| e.to_string())?,
            );
        }
        call = call.multipart(form);
    }
    let operation = async {
        let response = call.send().await.map_err(|e| {
            if e.is_timeout() {
                "图片服务超时；不会自动重试 / Image service timed out; no retry".to_owned()
            } else {
                "图片服务连接失败；不会自动重试 / Image service connection failed; no retry".into()
            }
        })?;
        let status = response.status();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| "图片返回中断；不会自动重试 / Image response interrupted; no retry")?;
            if bytes.len() + chunk.len() > 96 * 1024 * 1024 {
                return Err("图片服务返回超过 96 MiB / Image response exceeds limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let body = serde_json::from_slice::<Value>(&bytes).ok();
            let message = body
                .as_ref()
                .and_then(|v| v["error"]["message"].as_str())
                .unwrap_or("服务拒绝请求 / Request rejected")
                .chars()
                .take(800)
                .collect::<String>();
            return Err(format!(
                "图片服务错误 / Image service error ({}): {message}; 不会自动重试 / no retry",
                status.as_u16()
            ));
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "图片服务返回无效 JSON / Invalid image response")?;
        let data = body["data"]
            .as_array()
            .ok_or("图片服务没有返回图片 / Image service returned no images")?;
        if data.len() != request.count as usize {
            return Err(
                "返回的图片数量与请求不符 / Returned image count does not match request".into(),
            );
        }
        let mut images = vec![];
        let mut prompts = vec![];
        for item in data {
            let image = if let Some(encoded) = item["b64_json"].as_str() {
                if encoded.len() > 44 * 1024 * 1024 {
                    return Err("图片超过 32 MiB / Image exceeds limit".into());
                }
                STANDARD
                    .decode(encoded)
                    .map_err(|_| "图片编码损坏 / Invalid image encoding")?
            } else if aliyun {
                let raw = item["url"]
                    .as_str()
                    .ok_or("图片返回缺少内容或地址 / Image data or URL is missing")?;
                super::image_download::download(&client, raw, &service.base_url).await?
            } else {
                return Err("此适配器要求 b64_json 图片内容；仅有链接不能当作成功 / This adapter requires b64_json image bytes".into());
            };
            if image.is_empty() || image.len() > 32 * 1024 * 1024 {
                return Err("图片为空或过大 / Empty or oversized image".into());
            }
            images.push(image);
            prompts.push(item["revised_prompt"].clone());
        }
        Ok(ImageOutput {
            images,
            usage: body["usage"].clone(),
            revised_prompts: prompts,
        })
    };
    tokio::select! {
        biased;
        _ = stopped(stop) => Err("图片生成已停止；服务可能已计费，请核对用量，不会自动重试 / Stopped; provider may have charged; no retry".into()),
        result = tokio::time::timeout(timeout, operation) => result.unwrap_or_else(|_| Err("图片服务超时；不会自动重试 / Image service timed out; no retry".into()))
    }
}
