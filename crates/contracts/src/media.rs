use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MediaAsset {
    pub id: String,
    pub task_id: Option<String>,
    pub name: String,
    pub source: String,
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub at_ms: u64,
    pub units: u32,
    pub warnings: Vec<String>,
    pub image: Option<ImageDimensions>,
    pub path: Option<String>,
    pub version: Option<FileVersion>,
    pub operation_id: Option<String>,
    #[serde(default)]
    pub origin: Option<MediaAssetOrigin>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct DocumentUnit {
    pub locator: String,
    pub text: String,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImageProtocol {
    #[default]
    OpenaiImages,
    AliyunImages,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ImageService {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
    pub revision: u32,
    pub credential: Option<CredentialRef>,
    pub supports_edit: bool,
    pub sizes: Vec<String>,
    pub qualities: Vec<String>,
    pub formats: Vec<String>,
    pub max_count: u32,
    pub request_base64: bool,
    pub auth_required: bool,
    #[serde(default)]
    pub protocol: ImageProtocol,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaAdmin {
    BeginUpload {
        name: String,
        bytes: u64,
        source: String,
    },
    UploadChunk {
        upload_id: String,
        offset: u64,
        base64: String,
    },
    FinishUpload {
        upload_id: String,
    },
    CancelUpload {
        upload_id: String,
    },
    Bind {
        asset_ids: Vec<String>,
    },
    List,
    Read {
        asset_id: String,
        start: u32,
        limit: u32,
    },
    Preview {
        asset_id: String,
        page: u32,
    },
    CancelPreview {
        asset_id: String,
    },
    Remove {
        asset_id: String,
    },
    ImageServices,
    SaveImageService {
        service: ImageService,
        secret: Option<String>,
    },
    RemoveImageService {
        service_id: String,
    },
}
impl MediaAdmin {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::BeginUpload {
                name,
                bytes,
                source,
            } if name.is_empty()
                || name.len() > 255
                || name.contains(['/', '\\', '\0'])
                || *bytes == 0
                || *bytes > 32 * 1024 * 1024
                || !matches!(source.as_str(), "file" | "drop" | "paste") =>
            {
                Err(
                    "文件必须为 1 字节到 32 MiB，且名称有效。 / Invalid file name or size (32 MiB maximum).",
                )
            }
            Self::UploadChunk {
                upload_id, base64, ..
            } if !valid_id(upload_id) || base64.len() > 700_000 => Err("invalid upload chunk"),
            Self::FinishUpload { upload_id } | Self::CancelUpload { upload_id }
                if !valid_id(upload_id) =>
            {
                Err("invalid upload")
            }
            Self::Bind { asset_ids }
                if asset_ids.len() > 16 || asset_ids.iter().any(|x| !valid_id(x)) =>
            {
                Err("invalid attachments")
            }
            Self::Read {
                asset_id,
                start,
                limit,
            } if !valid_id(asset_id) || *start > 20000 || !(1..=32).contains(limit) => {
                Err("invalid document range")
            }
            Self::Preview { asset_id, page } if !valid_id(asset_id) || *page > 500 => {
                Err("invalid preview")
            }
            Self::Remove { asset_id } if !valid_id(asset_id) => Err("invalid asset"),
            Self::SaveImageService { service, secret } => {
                if !valid_id(&service.id)
                    || service.label.trim().is_empty()
                    || service.label.len() > 256
                    || service.model.trim().is_empty()
                    || service.model.len() > 256
                    || service.base_url.len() > 2048
                    || !(1..=4).contains(&service.max_count)
                    || service.sizes.is_empty()
                    || service.formats.is_empty()
                    || [&service.sizes, &service.qualities, &service.formats]
                        .iter()
                        .any(|v| v.len() > 24 || v.iter().any(|s| s.is_empty() || s.len() > 64))
                    || service
                        .formats
                        .iter()
                        .any(|s| !matches!(s.as_str(), "png" | "jpeg" | "webp"))
                    || secret
                        .as_ref()
                        .is_some_and(|s| s.len() > 4096 || s.contains(['\r', '\n', '\0']))
                {
                    Err("invalid image service configuration")
                } else {
                    Ok(())
                }
            }
            Self::RemoveImageService { service_id } if !valid_id(service_id) => {
                Err("invalid service")
            }
            _ => Ok(()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ImageRequest {
    pub service_id: String,
    pub service_revision: u32,
    pub prompt: String,
    pub size: String,
    pub quality: Option<String>,
    pub format: String,
    pub count: u32,
    pub references: Vec<String>,
    pub paths: Vec<String>,
    pub expected: Vec<FileVersion>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaEffect {
    CreateDocument {
        path: String,
        expected: FileVersion,
        format: String,
        recipe: serde_json::Value,
    },
    GenerateImage {
        request: ImageRequest,
    },
}
impl MediaEffect {
    pub fn paths(&self) -> Vec<String> {
        match self {
            Self::CreateDocument { path, .. } => vec![path.clone()],
            Self::GenerateImage { request } => request.paths.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::CreateDocument {
                path,
                format,
                recipe,
                ..
            } if path.is_empty()
                || path.len() > 4096
                || !matches!(
                    format.as_str(),
                    "docx" | "xlsx" | "pptx" | "pdf" | "txt" | "md" | "csv"
                )
                || serde_json::to_vec(recipe).map_or(true, |b| b.len() > 256 * 1024) =>
            {
                Err("invalid document generation")
            }
            Self::GenerateImage { request: r }
                if !valid_id(&r.service_id)
                    || r.prompt.trim().is_empty()
                    || r.prompt.len() > 32000
                    || !(1..=4).contains(&r.count)
                    || r.paths.len() != r.count as usize
                    || r.expected.len() != r.paths.len()
                    || r.paths.iter().any(|p| p.is_empty() || p.len() > 4096)
                    || r.references.len() > 4
                    || r.references.iter().any(|p| !valid_id(p))
                    || r.size.len() > 64
                    || r.quality.as_ref().is_some_and(|q| q.len() > 64)
                    || !matches!(r.format.as_str(), "png" | "jpeg" | "webp") =>
            {
                Err("invalid image request")
            }
            _ => Ok(()),
        }
    }
}
