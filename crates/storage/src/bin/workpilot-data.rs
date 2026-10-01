use std::{io::Write, path::PathBuf};
use workpilot_storage::Inspector;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        return Err("usage: workpilot-data <absolute channel data directory> events|export [after] [task_id]".into());
    }
    let directory = PathBuf::from(&args[0]);
    if !directory.is_absolute() {
        return Err("absolute data directory required".into());
    }
    let inspector = Inspector::open(&directory)?;
    let mut stdout = std::io::stdout().lock();
    match args[1].as_str() {
        "events" => {
            let after = args.get(2).map_or(Ok(0), |s| s.parse::<u64>())?;
            serde_json::to_writer(
                &mut stdout,
                &inspector.events(after, args.get(3).map(String::as_str), 256)?,
            )?;
            stdout.write_all(b"\n")?;
        }
        "export" => {
            inspector.export_events(&mut stdout, args.get(2).map(String::as_str))?;
        }
        _ => return Err("unsupported inspection command".into()),
    }
    Ok(())
}
