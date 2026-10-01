use std::{
    fs::OpenOptions,
    io::{self, Write},
    path::PathBuf,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::{mpsc, oneshot},
};
use workpilot_contracts::*;
use workpilot_platform::paths::{Channel, data_dir};
use workpilot_storage::{Storage, now_ms};
mod models;

struct Probe {
    request_id: String,
    task_id: String,
    current: u32,
    total: u32,
    interval: tokio::time::Interval,
}
type Failure = Box<dyn std::error::Error>;
async fn publish(sender: &mpsc::Sender<Wire>, events: Vec<Event>) -> Result<(), Failure> {
    for event in events {
        sender
            .send(Wire::Event {
                event: Box::new(event),
            })
            .await?;
    }
    Ok(())
}
async fn append(
    storage: &Storage,
    sender: &mpsc::Sender<Wire>,
    payload: Payload,
) -> Result<(), Failure> {
    let event = storage.call(move |s| s.append(None, None, payload)).await?;
    publish(sender, vec![event]).await
}
async fn finish(
    storage: &Storage,
    sender: &mpsc::Sender<Wire>,
    probe: Probe,
    completed: bool,
) -> Result<(), Failure> {
    let events = storage
        .call(move |s| s.finish_probe(&probe.task_id, &probe.request_id, completed))
        .await?;
    publish(sender, events).await
}
#[tokio::main]
async fn main() -> Result<(), Failure> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut channel = if cfg!(debug_assertions) || env!("CARGO_PKG_VERSION").contains('-') {
        Channel::Development
    } else {
        Channel::Release
    };
    let mut root = std::env::var_os("WORKPILOT_DATA_DIR").map(PathBuf::from);
    let mut index = 0;
    while index < args.len() {
        let value = args.get(index + 1).ok_or("expected argument value")?;
        match args[index].as_str() {
            "--channel" => {
                channel = match value.as_str() {
                    "development" => Channel::Development,
                    "test" => Channel::Test,
                    "release" => Channel::Release,
                    _ => return Err("invalid channel".into()),
                }
            }
            "--data-root" => root = Some(PathBuf::from(value)),
            _ => return Err("unknown argument".into()),
        }
        index += 2;
    }
    let directory = data_dir(channel, root.as_deref())?;
    let storage = Storage::open(directory.clone()).await?;
    // A bounded output worker keeps blocking stdout and diagnostic disk I/O off Tokio.
    // JSONL is a diagnostic mirror; SQLite is the sole state/replay authority.
    let log_path = directory.join(format!("probe-{}-{}.jsonl", now_ms(), std::process::id()));
    let (out, mut output) = mpsc::channel::<Wire>(32);
    let (flushed, flush_result) = oneshot::channel();
    std::thread::spawn(move || {
        let result = (|| -> io::Result<()> {
            let mut log = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(log_path)?;
            let mut stdout = io::stdout().lock();
            while let Some(wire) = output.blocking_recv() {
                if let Wire::Event { event } = &wire {
                    serde_json::to_writer(&mut log, event)?;
                    log.write_all(b"\n")?;
                }
                serde_json::to_writer(&mut stdout, &wire)?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
            log.flush()?;
            Ok(())
        })();
        let _ = flushed.send(result);
    });
    append(
        &storage,
        &out,
        Payload::Ready {
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").into(),
            data_dir: directory.display().to_string(),
        },
    )
    .await?;
    let mut models = models::Models::new(storage.clone(), out.clone(), &directory)?;
    let (sender, mut receiver) = mpsc::channel::<Result<Request, String>>(32);
    tokio::spawn(async move {
        let mut input = BufReader::new(tokio::io::stdin());
        loop {
            let mut line = zeroize::Zeroizing::new(String::new());
            let read = (&mut input)
                .take((MAX_COMMAND_BYTES + 1) as u64)
                .read_line(&mut line)
                .await;
            match read {
                Ok(0) => break,
                Ok(n) if n > MAX_COMMAND_BYTES => {
                    let _ = sender.send(Err("command exceeds 1 MiB".into())).await;
                    break;
                }
                Ok(_) => {
                    // Parser errors can embed untrusted input. Only emit fixed error text.
                    let request = serde_json::from_str::<Request>(&line)
                        .map_err(|_| "invalid command format".to_owned())
                        .and_then(|r| {
                            r.validate().map_err(str::to_owned)?;
                            Ok(r)
                        });
                    if sender.send(request).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = sender.send(Err("command pipe read failed".into())).await;
                    break;
                }
            }
        }
    });
    let mut probe: Option<Probe> = None;
    loop {
        tokio::select! {
            biased;
            request=receiver.recv()=>{
                let Some(request)=request else{break;};
                let request=match request{
                    Ok(r)=>r,Err(message)=>{append(&storage,&out,Payload::Error{code:ErrorCode::InvalidRequest,message}).await?;continue;}
                };
                if matches!(request.command,Command::Shutdown){break;}
                match models.dispatch(&request).await{
                    models::Handled::Reply(response)=>{out.send(Wire::Reply{request_id:request.request_id,response:*response}).await?;continue;},
                    models::Handled::Deferred=>continue,
                    models::Handled::No=>{},
                }
                if let Command::Read{query}=&request.command{
                    let query=query.clone();
                    let response=match storage.call(move|s|s.query(&query)).await{
                        Ok(r)=>r,Err(e)=>Response::Error{code:e.code(),message:e.to_string()},
                    };
                    out.send(Wire::Reply{request_id:request.request_id,response}).await?;
                    continue;
                }
                if matches!(request.command,Command::StartProbe{..})&&probe.is_some(){
                    // Still let storage distinguish a retry of the currently accepted command.
                    if probe.as_ref().is_none_or(|p|p.request_id!=request.request_id){
                        out.send(Wire::Reply{request_id:request.request_id,response:Response::Error{code:ErrorCode::Busy,message:"A probe is already running".into()}}).await?;
                        continue;
                    }
                }
                let to_apply=request.clone();
                match storage.call(move|s|s.apply(&to_apply)).await{
                    Ok((mut receipt,events))=>{
                        publish(&out,events).await?;
                        if !receipt.duplicate {
                            if matches!(request.command,Command::Stop){
                                if let Some(running)=probe.take(){finish(&storage,&out,running,false).await?;}
                                let control=request.request_id.clone();
                                let events=storage.call(move|s|s.finish_control(&control)).await?;
                                publish(&out,events).await?;
                                receipt.status=CommandStatus::Completed;
                            }
                            if let Command::StartProbe{ticks,interval_ms}=request.command{
                                let mut interval=tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
                                probe=Some(Probe{request_id:request.request_id.clone(),task_id:receipt.task_id.clone().unwrap(),current:0,total:ticks,interval});
                            }
                            if let Command::Cancel{task_id}=&request.command
                                && probe.as_ref().is_some_and(|p|&p.task_id==task_id){
                                finish(&storage,&out,probe.take().unwrap(),false).await?;
                            }
                        }
                        out.send(Wire::Reply{request_id:request.request_id,response:Response::Receipt{receipt}}).await?;
                    }
                    Err(error)=>{
                        out.send(Wire::Reply{request_id:request.request_id,response:Response::Error{code:error.code(),message:error.to_string()}}).await?;
                    }
                }
            }
            _=async{match probe.as_mut(){Some(p)=>{p.interval.tick().await;},None=>std::future::pending::<()>().await}}=>{
                if let Some(running)=probe.as_mut(){
                    running.current+=1;
                    let (task,request,current,total)=(running.task_id.clone(),running.request_id.clone(),running.current,running.total);
                    let event=storage.call(move|s|s.append(Some(&task),Some(&request),Payload::Progress{current,total})).await?;
                    publish(&out,vec![event]).await?;
                    if running.current==running.total{finish(&storage,&out,probe.take().unwrap(),true).await?;}
                }
            }
        }
    }
    models.shutdown().await;
    drop(models);
    if let Some(running) = probe.take() {
        finish(&storage, &out, running, false).await?;
    }
    append(&storage, &out, Payload::Bye).await?;
    drop(out);
    flush_result.await??;
    // No accepted database jobs remain; this barrier also flushes WAL checkpoints.
    storage.call(|_| Ok(())).await?;
    drop(storage);
    // Tokio's OS stdin reader cannot be cancelled. All owned writes have completed.
    std::process::exit(0)
}
