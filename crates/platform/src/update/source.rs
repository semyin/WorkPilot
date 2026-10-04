use super::{Preview, Result, inspect, io};
use std::{fs::File, io::Read, path::Path, time::Duration};

pub(crate) fn open(source: &str) -> Result<Box<dyn Read>> {
    if source.len() > 4096 {
        return Err("更新地址过长。".into());
    }
    if source.starts_with("https://") || source.starts_with("http://") {
        let url = reqwest::Url::parse(source).map_err(|_| "更新地址格式不正确。")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("更新源必须是 HTTPS 地址，不能包含账号密码。".into());
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| "无法初始化更新连接。")?;
        let response = client
            .get(url)
            .send()
            .map_err(|_| "更新源连接失败；请检查网络或使用本机签名包。")?;
        if !response.status().is_success() {
            return Err("更新源返回错误或重定向，请核对确切地址。".into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > super::MAX_PACKAGE + 16 * 1024 * 1024)
        {
            return Err("更新包超过支持的容量。".into());
        }
        Ok(Box::new(response))
    } else {
        let path = Path::new(source);
        if !path.is_absolute() {
            return Err("请选择本机更新包，或填写 HTTPS 更新源地址。".into());
        }
        super::files::regular(path)?;
        Ok(Box::new(io(File::open(path), "无法读取更新包")?))
    }
}
pub fn inspect_source(source: &str, current: &str) -> Result<Preview> {
    inspect(&mut open(source)?, current).map(|p| p.0)
}
