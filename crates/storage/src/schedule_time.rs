//! Pure civil-time calculations. Daily/weekly schedules skip nonexistent times
//! and use the earlier instant of a repeated local time, exactly once.
use crate::{Error, Result};
use chrono::{DateTime, Datelike, Days, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use workpilot_contracts::ScheduleRule;
pub const MAX_TIME: u64 = 253402300799999; // 9999-12-31, within JavaScript's exact integer range.
pub fn timezone(name: &str) -> Result<Tz> {
    name.parse()
        .map_err(|_| Error::Invalid("未知时区，请从列表选择 / Unknown IANA timezone"))
}
pub fn next(rule: &ScheduleRule, zone: &str, after: u64, anchor: u64) -> Result<Option<u64>> {
    rule.validate().map_err(Error::Invalid)?;
    let tz = timezone(zone)?;
    if after > MAX_TIME || anchor > MAX_TIME {
        return Err(Error::Invalid("time out of range"));
    }
    if let ScheduleRule::Interval { minutes } = rule {
        let step = u64::from(*minutes) * 60000;
        let n = if after < anchor {
            anchor
        } else {
            anchor
                .checked_add((after - anchor) / step * step)
                .and_then(|v| v.checked_add(step))
                .ok_or(Error::Invalid("time overflow"))?
        };
        return Ok((n <= MAX_TIME).then_some(n));
    }
    if let ScheduleRule::Once { local } = rule {
        let format = if local.len() == 16 {
            "%Y-%m-%dT%H:%M"
        } else {
            "%Y-%m-%dT%H:%M:%S"
        };
        let local = NaiveDateTime::parse_from_str(local, format)
            .map_err(|_| Error::Invalid("日期格式不正确 / Invalid local date and time"))?;
        let time = tz
            .from_local_datetime(&local)
            .earliest()
            .ok_or(Error::Invalid(
                "该时区不存在这个时刻，请重新选择 / This local time does not exist",
            ))?
            .timestamp_millis();
        if time < 0 || time as u64 > MAX_TIME {
            return Err(Error::Invalid("time out of range"));
        }
        return Ok((time as u64 > after).then_some(time as u64));
    }
    let now = DateTime::<Utc>::from_timestamp_millis(after as i64)
        .ok_or(Error::Invalid("time out of range"))?
        .with_timezone(&tz);
    let (hour, minute) = match rule {
        ScheduleRule::Daily { hour, minute } | ScheduleRule::Weekly { hour, minute, .. } => {
            (*hour, *minute)
        }
        _ => unreachable!(),
    };
    for day in 0..15 {
        let Some(date) = now.date_naive().checked_add_days(Days::new(day)) else {
            break;
        };
        if let ScheduleRule::Weekly { weekdays, .. } = rule
            && !weekdays.contains(&date.weekday().number_from_monday())
        {
            continue;
        }
        let local = date
            .and_hms_opt(hour, minute, 0)
            .ok_or(Error::Invalid("invalid local time"))?;
        if let Some(time) = tz.from_local_datetime(&local).earliest() {
            let ms = time.timestamp_millis();
            if ms >= 0 && ms as u64 > after && ms as u64 <= MAX_TIME {
                return Ok(Some(ms as u64));
            }
        }
    }
    Ok(None)
}
/// An overdue range is represented once; never enumerate years of missed runs.
pub fn missed_count(rule: &ScheduleRule, due: u64, now: u64) -> Option<u64> {
    match rule {
        ScheduleRule::Once { .. } => Some(1),
        ScheduleRule::Interval { minutes } => {
            Some((now.saturating_sub(due)) / (u64::from(*minutes) * 60000) + 1)
        }
        _ => None,
    }
}
