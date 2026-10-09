use super::execution_tests::{queue, setup};
use super::*;

fn request(command: Command) -> Request {
    Request {
        request_id: id(),
        command,
    }
}

fn group(store: &mut Store) -> (String, Vec<TeamMember>, ProviderProfile) {
    let (task, profile) = setup(store);
    let settings = TeamSettings::default();
    store
        .configure_team(
            &request(Command::ConfigureTeam {
                task_id: task.clone(),
                settings: settings.clone(),
            }),
            &task,
            &settings,
        )
        .unwrap();
    let members = ["writer", "reviewer"].map(|key| MemberSpec {
        key: key.into(),
        role: key.into(),
        goal: key.into(),
        profile_id: None,
        depends_on: if key == "reviewer" {
            vec!["writer".into()]
        } else {
            vec![]
        },
    });
    store
        .delegate_members(&task, &members, None, None, None)
        .unwrap();
    let members = store.direct_members(&task).unwrap();
    (task, members, profile)
}

#[test]
fn delete_task_removes_group_and_attachment_rows_but_preserves_files_and_other_tasks() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (task, members, _) = group(&mut store);
    let (other, _) = setup(&mut store);
    let file = directory.path().join("user-output.txt");
    std::fs::write(&file, "keep the project file").unwrap();
    store
        .connection
        .execute(
            "INSERT INTO artifacts(id,task_id,path) VALUES('output',?1,?2)",
            params![task, file.to_string_lossy()],
        )
        .unwrap();
    // Bound media used to prevent even single-task deletion via its foreign key.
    store.connection.execute(
        "INSERT INTO media_assets(id,task_id,data_json,original_blob,parsed_blob) VALUES('attachment',?1,'{}','original','parsed')",
        [&members[0].task_id],
    ).unwrap();
    let delete = request(Command::DeleteTask {
        task_id: task.clone(),
    });
    let (receipt, events) = store.apply(&delete).unwrap();
    assert_eq!(receipt.status, CommandStatus::Completed);
    assert!(events.iter().all(|event| event.task_id.is_none()));
    for id in std::iter::once(&task).chain(members.iter().map(|member| &member.task_id)) {
        assert!(matches!(store.task(id), Err(Error::NotFound)));
    }
    assert!(store.task(&other).is_ok());
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        "keep the project file"
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM media_assets", [], |r| r
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, u32>(
                0
            ))
            .unwrap(),
        0
    );
    assert!(store.apply(&delete).unwrap().0.duplicate);
    drop(store);
    let store = Store::open(directory.path()).unwrap();
    assert!(matches!(store.task(&task), Err(Error::NotFound)));
    assert!(store.task(&other).is_ok());
}

#[test]
fn delete_task_rechecks_every_member_and_never_deletes_a_partial_group() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let (task, members, profile) = group(&mut store);
    assert!(
        store
            .apply(&request(Command::DeleteTask {
                task_id: members[0].task_id.clone()
            }))
            .is_err()
    );
    let delete = request(Command::DeleteTask {
        task_id: task.clone(),
    });
    store.team_set_enabled(&task, true, false).unwrap();
    assert!(store.apply(&delete).is_err());
    store.team_set_enabled(&task, false, true).unwrap();
    let run = queue(&mut store, &members[0].task_id, &profile);
    assert!(store.apply(&delete).is_err());
    store.activate_execution(&run).unwrap();
    assert!(store.apply(&delete).is_err());
    for id in std::iter::once(&task).chain(members.iter().map(|member| &member.task_id)) {
        assert!(store.task(id).is_ok());
    }
    assert!(store.cached_receipt(&delete).unwrap().is_none());
    store
        .finish_execution(&run, TaskState::Completed, "finished", None)
        .unwrap();
    store.apply(&delete).unwrap();
    assert!(matches!(store.task(&task), Err(Error::NotFound)));
}

#[test]
fn legacy_task_can_be_inspected_before_deletion_without_enabling_a_team() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path()).unwrap();
    let task = store
        .apply(&request(Command::CreateTask {
            title: "Legacy task".into(),
            project_id: None,
        }))
        .unwrap()
        .0
        .task_id
        .unwrap();
    let view = store.team_view(&task).unwrap();
    assert_eq!(view.root_task_id, task);
    assert!(!view.settings.enabled);
    assert!(view.members.is_empty());
    store
        .apply(&request(Command::DeleteTask {
            task_id: task.clone(),
        }))
        .unwrap();
    assert!(matches!(store.task(&task), Err(Error::NotFound)));
}
