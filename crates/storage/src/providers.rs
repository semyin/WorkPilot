use super::*;
use std::collections::HashMap;

impl Store {
    pub fn profile(&self, profile_id: &str) -> Result<ProviderProfile> {
        let data: String = self
            .connection
            .query_row(
                "SELECT data_json FROM provider_profiles WHERE id=?1",
                [profile_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let mut p: ProviderProfile = serde_json::from_str(&data)?;
        if p.capabilities.tools.source == CapabilitySource::Unknown && p.supports_tools.is_some() {
            p.capabilities.tools = Capability {
                supported: p.supports_tools,
                source: CapabilitySource::User,
                checked_at_ms: None,
            };
        }
        if p.capabilities.images.source == CapabilitySource::Unknown && p.supports_images.is_some()
        {
            p.capabilities.images = Capability {
                supported: p.supports_images,
                source: CapabilitySource::User,
                checked_at_ms: None,
            };
        }
        Ok(p)
    }
    pub fn profiles(&self) -> Result<Vec<ProviderProfile>> {
        let mut statement = self
            .connection
            .prepare("SELECT id FROM provider_profiles ORDER BY id LIMIT 129")?;
        let ids: Vec<String> = statement
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        if ids.len() > 128 {
            return Err(Error::Invalid("profile count exceeds 128"));
        }
        ids.iter()
            .map(|id| self.profile_with_observations(id))
            .collect()
    }
    pub fn profile_with_observations(&self, id: &str) -> Result<ProviderProfile> {
        let mut p = self.profile(id)?;
        let mut statement=self.connection.prepare("SELECT capability,supported,checked_at_ms FROM capability_observations WHERE profile_id=?1 AND revision=?2")?;
        for row in statement.query_map(params![id, p.revision], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, bool>(1)?,
                r.get::<_, u64>(2)?,
            ))
        })? {
            let (name, supported, at) = row?;
            let cap = match name.as_str() {
                "text" => &mut p.capabilities.text,
                "streaming" => &mut p.capabilities.streaming,
                "tools" => &mut p.capabilities.tools,
                "images" => &mut p.capabilities.images,
                "usage" => &mut p.capabilities.usage,
                _ => continue,
            };
            if cap.source == CapabilitySource::Unknown {
                *cap = Capability {
                    supported: Some(supported),
                    source: CapabilitySource::Observed,
                    checked_at_ms: Some(at),
                };
            }
        }
        Ok(p)
    }
    pub fn global_profile(&self) -> Result<Option<String>> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='default_profile'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        value
            .map(|v| serde_json::from_str(&v).map_err(Error::from))
            .transpose()
    }
    pub fn resolve_profile(
        &self,
        task_id: Option<&str>,
        agent_id: Option<&str>,
        explicit: Option<&str>,
    ) -> Result<ProviderProfile> {
        let task = task_id.map(|id| self.task(id)).transpose()?;
        let agent_profile = if let Some(agent_id) = agent_id {
            let (parent, data): (String, String) = self
                .connection
                .query_row(
                    "SELECT task_id,data_json FROM agents WHERE id=?1",
                    [agent_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or(Error::NotFound)?;
            if task_id != Some(parent.as_str()) {
                return Err(Error::Invalid("agent belongs to another task"));
            }
            let value: serde_json::Value = serde_json::from_str(&data)?;
            value["profile_id"].as_str().map(str::to_owned)
        } else {
            None
        };
        let mut selected = explicit
            .map(str::to_owned)
            .or(agent_profile)
            .or_else(|| task.as_ref().and_then(|t| t.profile_id.clone()));
        if selected.is_none()
            && let Some(project) = task.as_ref().and_then(|t| t.project_id.as_ref())
        {
            let raw: String = self.connection.query_row(
                "SELECT data_json FROM projects WHERE id=?1",
                [project],
                |r| r.get(0),
            )?;
            selected = serde_json::from_str::<serde_json::Value>(&raw)?["default_profile_id"]
                .as_str()
                .map(str::to_owned);
        }
        if selected.is_none() {
            selected = self.global_profile()?;
        }
        self.profile_with_observations(
            selected
                .as_deref()
                .ok_or(Error::Invalid("no model is configured"))?,
        )
    }
    pub fn cached_receipt(&self, request: &Request) -> Result<Option<Receipt>> {
        request.validate().map_err(Error::Invalid)?;
        let old: Option<(String, String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT fingerprint,status,task_id FROM commands WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((fingerprint, status, task_id)) = old {
            if fingerprint != fingerprint_of(request)? {
                return Err(Error::Conflict);
            }
            return Ok(Some(Receipt {
                request_id: request.request_id.clone(),
                status: parse_word(status)?,
                task_id,
                duplicate: true,
            }));
        }
        Ok(None)
    }
    pub fn commit_profile(
        &mut self,
        request: &Request,
        mut profile: ProviderProfile,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        let existing = self.profile(&profile.id);
        match existing {
            Ok(old) => {
                if old.revision != profile.revision {
                    return Err(Error::Conflict);
                }
                profile.revision = old.revision.checked_add(1).ok_or(Error::Conflict)?;
            }
            Err(Error::NotFound) => {
                let count: u32 = self.connection.query_row(
                    "SELECT count(*) FROM provider_profiles",
                    [],
                    |r| r.get(0),
                )?;
                if count >= 128 || profile.revision != 1 {
                    return Err(Error::Invalid("profile limit or initial revision"));
                }
            }
            Err(error) => return Err(error),
        }
        clear_observed(&mut profile);
        let mut data = serde_json::to_value(&profile)?;
        self.redactor.value(&mut data);
        let snapshot = profile.without_credential();
        let mut safe_snapshot = serde_json::to_value(&snapshot)?;
        self.redactor.value(&mut safe_snapshot);
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",params![profile.id,encode(&data)?])?;
        tx.execute(
            "INSERT INTO profile_versions(profile_id,revision,snapshot_json) VALUES(?1,?2,?3)",
            params![profile.id, profile.revision, encode(&safe_snapshot)?],
        )?;
        let events = finish_configuration(
            &tx,
            &self.redactor,
            request,
            Payload::ProviderSaved {
                profile_id: profile.id.clone(),
                revision: profile.revision,
            },
        )?;
        tx.commit()?;
        Ok(events)
    }
    pub fn set_default_profile(
        &mut self,
        request: &Request,
        scope: &ProfileScope,
        profile: Option<&str>,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        if let Some(profile) = profile {
            self.profile(profile)?;
        }
        let tx = self.connection.transaction()?;
        let changed=match scope{
            ProfileScope::Global=>{
                if let Some(profile)=profile{tx.execute("INSERT INTO settings(key,value_json) VALUES('default_profile',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[encode(&profile)?])?;}
                else{tx.execute("DELETE FROM settings WHERE key='default_profile'",[])?;}1
            }
            ProfileScope::Project{id}=>tx.execute("UPDATE projects SET data_json=json_set(data_json,'$.default_profile_id',?2) WHERE id=?1",params![id,profile])?,
            ProfileScope::Task{id}=>tx.execute("UPDATE tasks SET profile_id=?2 WHERE id=?1",params![id,profile])?,
            ProfileScope::Agent{id}=>tx.execute("UPDATE agents SET data_json=json_set(data_json,'$.profile_id',?2) WHERE id=?1",params![id,profile])?,
        };
        if changed != 1 {
            return Err(Error::NotFound);
        }
        let events = finish_configuration(
            &tx,
            &self.redactor,
            request,
            Payload::ProfileDefaultChanged {
                scope: scope.clone(),
                profile_id: profile.map(str::to_owned),
            },
        )?;
        tx.commit()?;
        Ok(events)
    }
    pub fn delete_profile(
        &mut self,
        request: &Request,
        profile: &str,
        revision: u32,
    ) -> Result<(Option<CredentialRef>, Vec<Event>)> {
        if self.cached_receipt(request)?.is_some() {
            return Ok((None, vec![]));
        }
        let old = self.profile(profile)?;
        if old.revision != revision {
            return Err(Error::Conflict);
        }
        let tx = self.connection.transaction()?;
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_calls WHERE profile_id=?1 AND state='running')",
            [profile],
            |r| r.get(0),
        )?;
        if active {
            return Err(Error::Busy);
        }
        // Keep explicit selections intact. Callers must deliberately clear/reassign them first.
        let bound:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE profile_id=?1) OR EXISTS(SELECT 1 FROM projects WHERE json_extract(data_json,'$.default_profile_id')=?1) OR EXISTS(SELECT 1 FROM agents WHERE json_extract(data_json,'$.profile_id')=?1) OR EXISTS(SELECT 1 FROM settings WHERE key='default_profile' AND json_extract(value_json,'$')=?1)",[profile],|r|r.get(0))?;
        if bound {
            return Err(Error::Busy);
        }
        tx.execute("DELETE FROM provider_profiles WHERE id=?1", [profile])?;
        let events = finish_configuration(
            &tx,
            &self.redactor,
            request,
            Payload::ProviderRemoved {
                profile_id: profile.into(),
            },
        )?;
        tx.commit()?;
        Ok((old.credential, events))
    }
    pub fn export_profiles(&self) -> Result<ProfileBundle> {
        let profiles = self
            .profiles()?
            .into_iter()
            .map(|mut p| {
                p.credential = None;
                clear_observed(&mut p);
                p
            })
            .collect();
        Ok(ProfileBundle {
            format: "workpilot.profiles".into(),
            version: 1,
            profiles,
            global_default: self.global_profile()?,
        })
    }
    pub fn import_profiles(
        &mut self,
        request: &Request,
        bundle: &ProfileBundle,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        if bundle.format != "workpilot.profiles"
            || bundle.version != 1
            || bundle.profiles.len() > 128
            || bundle.profiles.iter().any(|p| p.credential.is_some())
        {
            return Err(Error::Invalid(
                "profile bundle must not contain credentials",
            ));
        }
        let existing: u32 =
            self.connection
                .query_row("SELECT count(*) FROM provider_profiles", [], |r| r.get(0))?;
        if existing as usize + bundle.profiles.len() > 128 {
            return Err(Error::Invalid("profile limit"));
        }
        let mut mapping = HashMap::new();
        let default = self.global_profile()?;
        let tx = self.connection.transaction()?;
        for original in &bundle.profiles {
            if mapping.contains_key(&original.id) {
                return Err(Error::Invalid("duplicate profile id in bundle"));
            }
            let mut profile = original.without_credential();
            profile.id = id();
            profile.revision = 1;
            clear_observed(&mut profile);
            mapping.insert(original.id.clone(), profile.id.clone());
            let mut value = serde_json::to_value(&profile)?;
            self.redactor.value(&mut value);
            let data = encode(&value)?;
            tx.execute(
                "INSERT INTO provider_profiles(id,data_json) VALUES(?1,?2)",
                params![profile.id, data],
            )?;
            tx.execute(
                "INSERT INTO profile_versions(profile_id,revision,snapshot_json) VALUES(?1,1,?2)",
                params![profile.id, data],
            )?;
        }
        if let Some(old) = &bundle.global_default {
            let mapped = mapping
                .get(old)
                .ok_or(Error::Invalid("unknown imported default"))?;
            if default.is_none() {
                tx.execute(
                    "INSERT INTO settings(key,value_json) VALUES('default_profile',?1)",
                    [encode(mapped)?],
                )?;
            }
        }
        let events = finish_configuration(
            &tx,
            &self.redactor,
            request,
            Payload::ProvidersImported {
                count: bundle.profiles.len() as u32,
            },
        )?;
        tx.commit()?;
        Ok(events)
    }
    pub fn start_model_call(
        &mut self,
        request: &Request,
        profile: &ProviderProfile,
        mode: ModelProbeMode,
        task_id: Option<&str>,
    ) -> Result<(ModelCallRecord, bool, Vec<Event>)> {
        if self.cached_receipt(request)?.is_some() {
            return Ok((
                self.model_call_for_request(&request.request_id)?,
                true,
                vec![],
            ));
        }
        if let Some(task) = task_id {
            let task = self.task(task)?;
            if matches!(
                task.state,
                TaskState::Running
                    | TaskState::Stopping
                    | TaskState::AwaitingApproval
                    | TaskState::AwaitingInput
            ) {
                return Err(Error::Busy);
            }
        }
        let task = task_id.map(str::to_owned).unwrap_or_else(id);
        let call = id();
        let run = id();
        let stamp = now_ms();
        let snapshot = profile.without_credential();
        let mut safe = serde_json::to_value(&snapshot)?;
        self.redactor.value(&mut safe);
        let tx = self.connection.transaction()?;
        if task_id.is_none() {
            tx.execute("INSERT INTO tasks(id,title,state,mode,permission,profile_id,created_at_ms,updated_at_ms) VALUES(?1,'P02 model connection test','running','chat','request_approval',?2,?3,?3)",params![task,profile.id,stamp])?;
        } else {
            tx.execute(
                "UPDATE tasks SET state='running',updated_at_ms=?2 WHERE id=?1",
                params![task, stamp],
            )?;
        }
        let mut events = accept_command(&tx, &self.redactor, request, Some(&task))?;
        tx.execute(
            "INSERT INTO runs(id,task_id,state,started_at_ms) VALUES(?1,?2,'running',?3)",
            params![run, task, stamp],
        )?;
        tx.execute("INSERT INTO model_calls(id,request_id,task_id,run_id,profile_id,profile_revision,snapshot_json,mode,state,started_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'running',?9)",
            params![call,request.request_id,task,run,profile.id,profile.revision,encode(&safe)?,word(&mode)?,stamp])?;
        events.push(record(
            &tx,
            &self.redactor,
            Some(&task),
            Some(&request.request_id),
            EventSource::Provider,
            Payload::ModelCallStarted {
                call_id: call.clone(),
                profile_id: profile.id.clone(),
                profile_revision: profile.revision,
                mode,
            },
        )?);
        tx.commit()?;
        Ok((self.model_call(&call)?, false, events))
    }
    pub fn append_model_text(
        &mut self,
        call_id: &str,
        text: &str,
        reasoning: bool,
    ) -> Result<Event> {
        let call = self.model_call(call_id)?;
        if call.state != ModelCallState::Running {
            return Err(Error::Conflict);
        }
        // Provider deltas can contain long strings; structured objects are bounded separately.
        let content = self.save_json(serde_json::json!({"text":text}))?;
        let tx = self.connection.transaction()?;
        let payload = if reasoning {
            Payload::ModelReasoning {
                call_id: call_id.into(),
                content,
            }
        } else {
            Payload::ModelText {
                call_id: call_id.into(),
                content,
            }
        };
        let event = record(
            &tx,
            &self.redactor,
            Some(&call.task_id),
            None,
            EventSource::Provider,
            payload,
        )?;
        tx.commit()?;
        Ok(event)
    }
    pub fn finish_model_call(
        &mut self,
        call_id: &str,
        result: std::result::Result<ModelOutput, ModelDiagnostic>,
    ) -> Result<Vec<Event>> {
        self.finish_model_call_inner(call_id, result, None)
    }
    pub fn cancel_model_call(
        &mut self,
        request: &Request,
        call_id: &str,
        diagnostic: ModelDiagnostic,
    ) -> Result<Vec<Event>> {
        if self.cached_receipt(request)?.is_some() {
            return Ok(vec![]);
        }
        if self.model_call(call_id)?.state == ModelCallState::Running {
            return self.finish_model_call_inner(call_id, Err(diagnostic), Some(request));
        }
        let tx = self.connection.transaction()?;
        let events = finish_configuration(&tx, &self.redactor, request, Payload::CancelRequested)?;
        tx.commit()?;
        Ok(events)
    }
    fn finish_model_call_inner(
        &mut self,
        call_id: &str,
        result: std::result::Result<ModelOutput, ModelDiagnostic>,
        control: Option<&Request>,
    ) -> Result<Vec<Event>> {
        let call = self.model_call(call_id)?;
        if call.state != ModelCallState::Running {
            return Err(Error::Conflict);
        }
        let (state, task_state, command_state, output, diagnostic, usage) = match result {
            Ok(output) => {
                let usage = output.usage.clone();
                let content = self.save_json(serde_json::to_value(&output)?)?;
                (
                    ModelCallState::Completed,
                    TaskState::Completed,
                    CommandStatus::Completed,
                    Some(content),
                    None,
                    Some(usage),
                )
            }
            Err(diagnostic) => {
                let cancelled = diagnostic.code == ModelErrorCode::Cancelled;
                let mut value = serde_json::to_value(diagnostic)?;
                self.redactor.value(&mut value);
                (
                    if cancelled {
                        ModelCallState::Cancelled
                    } else {
                        ModelCallState::Failed
                    },
                    if cancelled {
                        TaskState::Interrupted
                    } else {
                        TaskState::Failed
                    },
                    if cancelled {
                        CommandStatus::Interrupted
                    } else {
                        CommandStatus::Failed
                    },
                    None,
                    Some(serde_json::from_value::<ModelDiagnostic>(value)?),
                    None,
                )
            }
        };
        let tx = self.connection.transaction()?;
        let mut events = if let Some(control) = control {
            let mut events = accept_command(&tx, &self.redactor, control, Some(&call.task_id))?;
            events.push(record(
                &tx,
                &self.redactor,
                Some(&call.task_id),
                Some(&control.request_id),
                EventSource::User,
                Payload::CancelRequested,
            )?);
            events
        } else {
            vec![]
        };
        let (run, request): (String, String) = tx.query_row(
            "SELECT run_id,request_id FROM model_calls WHERE id=?1",
            [call_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if tx.execute("UPDATE model_calls SET state=?2,ended_at_ms=?3,output_object_id=?4,diagnostic_json=?5,usage_json=?6 WHERE id=?1 AND state='running'",
            params![call_id,word(&state)?,now_ms(),output.as_ref().map(|o|o.object_id.as_str()),diagnostic.as_ref().map(encode).transpose()?,usage.as_ref().map(encode).transpose()?])?!=1{return Err(Error::Conflict);}
        tx.execute("UPDATE runs SET state=?2,ended_at_ms=?3,result_object_id=?4,failure_code=?5 WHERE id=?1",
            params![run,word(&task_state)?,now_ms(),output.as_ref().map(|o|o.object_id.as_str()),diagnostic.as_ref().map(|d|word(&d.code)).transpose()?])?;
        tx.execute(
            "UPDATE tasks SET state=?2,updated_at_ms=?3 WHERE id=?1",
            params![call.task_id, word(&task_state)?, now_ms()],
        )?;
        tx.execute(
            "UPDATE commands SET status=?2,finished_at_ms=?3 WHERE request_id=?1",
            params![request, word(&command_state)?, now_ms()],
        )?;
        events.extend([
            record(
                &tx,
                &self.redactor,
                Some(&call.task_id),
                Some(&request),
                EventSource::Provider,
                Payload::ModelCallEnded {
                    call_id: call_id.into(),
                    state,
                    diagnostic,
                    output,
                    usage,
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(&call.task_id),
                Some(&request),
                EventSource::Engine,
                Payload::TaskStateChanged {
                    state: task_state,
                    reason: None,
                },
            )?,
            record(
                &tx,
                &self.redactor,
                Some(&call.task_id),
                Some(&request),
                EventSource::Engine,
                Payload::CommandFinished {
                    status: command_state,
                },
            )?,
        ]);
        if let Some(control) = control {
            tx.execute(
                "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
                params![control.request_id, now_ms()],
            )?;
            events.push(record(
                &tx,
                &self.redactor,
                Some(&call.task_id),
                Some(&control.request_id),
                EventSource::Engine,
                Payload::CommandFinished {
                    status: CommandStatus::Completed,
                },
            )?);
        }
        tx.commit()?;
        Ok(events)
    }
    pub fn record_capabilities(&mut self, call_id: &str, output: &ModelOutput) -> Result<()> {
        let call = self.model_call(call_id)?;
        if call.state != ModelCallState::Completed {
            return Err(Error::Conflict);
        }
        let mut names = vec!["streaming"];
        if !output.text.is_empty() {
            names.push("text");
        }
        if !output.tool_calls.is_empty() {
            names.push("tools");
        }
        if call.mode == ModelProbeMode::Image {
            names.push("images");
        }
        if output.usage.input_tokens.is_some() || output.usage.output_tokens.is_some() {
            names.push("usage");
        }
        let tx = self.connection.transaction()?;
        for name in names {
            tx.execute("INSERT INTO capability_observations(profile_id,revision,capability,supported,checked_at_ms) VALUES(?1,?2,?3,1,?4) ON CONFLICT(profile_id,revision,capability) DO UPDATE SET supported=1,checked_at_ms=excluded.checked_at_ms",
                params![call.profile_id,call.profile_revision,name,now_ms()])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn model_call_for_request(&self, request: &str) -> Result<ModelCallRecord> {
        let id: String = self
            .connection
            .query_row(
                "SELECT id FROM model_calls WHERE request_id=?1",
                [request],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        self.model_call(&id)
    }
    pub fn model_call(&self, id: &str) -> Result<ModelCallRecord> {
        let raw=self.connection.query_row("SELECT task_id,profile_id,profile_revision,snapshot_json,mode,state,started_at_ms,ended_at_ms,output_object_id,diagnostic_json,usage_json FROM model_calls WHERE id=?1",[id],|r|Ok((
            r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,u32>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,
            r.get::<_,u64>(6)?,r.get::<_,Option<u64>>(7)?,r.get::<_,Option<String>>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,Option<String>>(10)?
        ))).optional()?.ok_or(Error::NotFound)?;
        Ok(ModelCallRecord {
            id: id.into(),
            task_id: raw.0,
            profile_id: raw.1,
            profile_revision: raw.2,
            profile_snapshot: serde_json::from_str(&raw.3)?,
            mode: parse_word(raw.4)?,
            state: parse_word(raw.5)?,
            started_at_ms: raw.6,
            ended_at_ms: raw.7,
            output: raw
                .8
                .map(|id| content_ref(&self.connection, &id))
                .transpose()?,
            diagnostic: raw.9.map(|s| serde_json::from_str(&s)).transpose()?,
            usage: raw.10.map(|s| serde_json::from_str(&s)).transpose()?,
        })
    }
    pub fn model_calls(&self, limit: u32) -> Result<Vec<ModelCallRecord>> {
        if !(1..=64).contains(&limit) {
            return Err(Error::Invalid("model calls page"));
        }
        let mut statement = self
            .connection
            .prepare("SELECT id FROM model_calls ORDER BY started_at_ms DESC,id DESC LIMIT ?1")?;
        let ids: Vec<String> = statement
            .query_map([limit], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        ids.iter().map(|id| self.model_call(id)).collect()
    }
    pub(crate) fn recover_model_calls(&mut self) -> Result<()> {
        let tx = self.connection.transaction()?;
        loop {
            let call: Option<(String, String)> = tx
                .query_row(
                    "SELECT id,task_id FROM model_calls WHERE state='running' LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((id, task)) = call else {
                break;
            };
            tx.execute(
                "UPDATE model_calls SET state='interrupted',ended_at_ms=?2 WHERE id=?1",
                params![id, now_ms()],
            )?;
            record(
                &tx,
                &self.redactor,
                Some(&task),
                None,
                EventSource::Recovery,
                Payload::ModelCallEnded {
                    call_id: id,
                    state: ModelCallState::Interrupted,
                    diagnostic: None,
                    output: None,
                    usage: None,
                },
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn save_json(&mut self, mut value: serde_json::Value) -> Result<ContentRef> {
        self.redactor.value(&mut value);
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(Error::Invalid("structured output exceeds 8 MiB"));
        }
        let content = objects::put_json(&self.directory, &bytes)?;
        self.connection.execute(
            "INSERT OR IGNORE INTO objects(id,bytes,media_type) VALUES(?1,?2,?3)",
            params![content.object_id, content.bytes, content.media_type],
        )?;
        content_ref(&self.connection, &content.object_id)
    }
}
fn fingerprint_of(request: &Request) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&request.command)?)
    ))
}
fn accept_command(
    connection: &Connection,
    redactor: &Redactor,
    request: &Request,
    task: Option<&str>,
) -> Result<Vec<Event>> {
    let kind = serde_json::to_value(&request.command)?["kind"]
        .as_str()
        .unwrap()
        .to_owned();
    connection.execute("INSERT INTO commands(request_id,fingerprint,command_kind,status,task_id,accepted_at_ms) VALUES(?1,?2,?3,'accepted',?4,?5)",params![request.request_id,fingerprint_of(request)?,kind,task,now_ms()])?;
    Ok(vec![record(
        connection,
        redactor,
        task,
        Some(&request.request_id),
        EventSource::User,
        Payload::CommandAccepted { command_kind: kind },
    )?])
}
fn finish_configuration(
    connection: &Connection,
    redactor: &Redactor,
    request: &Request,
    payload: Payload,
) -> Result<Vec<Event>> {
    let mut events = accept_command(connection, redactor, request, None)?;
    events.push(record(
        connection,
        redactor,
        None,
        Some(&request.request_id),
        EventSource::User,
        payload,
    )?);
    connection.execute(
        "UPDATE commands SET status='completed',finished_at_ms=?2 WHERE request_id=?1",
        params![request.request_id, now_ms()],
    )?;
    events.push(record(
        connection,
        redactor,
        None,
        Some(&request.request_id),
        EventSource::Engine,
        Payload::CommandFinished {
            status: CommandStatus::Completed,
        },
    )?);
    Ok(events)
}
fn clear_observed(p: &mut ProviderProfile) {
    for cap in [
        &mut p.capabilities.text,
        &mut p.capabilities.streaming,
        &mut p.capabilities.tools,
        &mut p.capabilities.images,
        &mut p.capabilities.usage,
    ] {
        if cap.source != CapabilitySource::User {
            *cap = Capability::default();
        } else {
            cap.checked_at_ms = None;
        }
    }
    p.supports_tools = p.capabilities.tools.supported;
    p.supports_images = p.capabilities.images.supported;
}
