//! Test-only process entry. No environment-controlled fault hook is shipped in the update helper.
use super::{Prepared, data_update_lock, files, install};
use std::{path::PathBuf, time::Duration};

#[test]
#[ignore = "Only launched by update-recovery-process-test.mjs as a child that is deliberately killed"]
fn interrupt_after_original_program_was_saved() {
    let Some(record) = std::env::var_os("WORKPILOT_RECOVERY_TEST_RECORD") else {
        return;
    };
    let record = PathBuf::from(record);
    let mut p: Prepared = files::read_json(&record).unwrap();
    assert_eq!(record, p.job.join("prepared.json"));
    let _installation = install::transaction::installation_lock(&p.install).unwrap();
    let _data = data_update_lock(&p.data, true).unwrap();
    let mut engine = Some(install::lock_engine(&p.data).unwrap());
    install::transaction::steps(
        &mut p,
        install::verify_stage,
        install::transaction::migrate,
        |phase| {
            if phase == "ready_to_switch" {
                engine.take();
            }
            if phase == "application_saved" {
                std::fs::write(
                    record.with_file_name("test-child-at-boundary.json"),
                    serde_json::to_vec(
                        &serde_json::json!({"phase":phase,"pid":std::process::id()}),
                    )
                    .unwrap(),
                )
                .unwrap();
                // The integration-test parent kills this independent process. No rollback runs here.
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("the integration-test parent should kill the test child at application_saved");
}
