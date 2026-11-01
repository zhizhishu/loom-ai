//! JSON frames for the outbound node channel.
//!
//! The node dials `GET /api/v1/nodes/connect`. Bytes travel as base64 inside
//! text frames so one codec covers heartbeat, dispatch, and process output.
//! Sequence numbers are per run, starting at 1, shared by stdout and stderr.

use serde::{Deserialize, Serialize};

pub const CONNECT_PATH: &str = "/api/v1/nodes/connect";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliReport {
    pub adapter_kind: String,
    pub path: String,
    pub version: Option<String>,
    pub path_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ClientMessage {
    Pair {
        pairing_code: String,
    },
    Hello {
        node_id: String,
        token: String,
        os: String,
        arch: String,
        clis: Vec<CliReport>,
    },
    Heartbeat {
        run_ids: Vec<String>,
    },
    Output {
        run_id: String,
        stream: OutputStream,
        seq: u64,
        data: String,
    },
    Exit {
        run_id: String,
        seq: u64,
        exit_code: i32,
    },
    AlreadyRunning {
        run_id: String,
        attempt: u32,
        seq: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ServerMessage {
    Paired {
        node_id: String,
        token: String,
    },
    Welcome {
        node_id: String,
    },
    HeartbeatAck,
    Ack {
        run_id: String,
        seq: u64,
    },
    Start {
        run_id: String,
        attempt: u32,
        adapter_kind: String,
        program: String,
        args: Vec<String>,
        cwd: String,
        env: Vec<(String, String)>,
    },
    Error {
        code: String,
    },
}

impl ClientMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("client frame serializes")
    }
}

impl ServerMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server frame serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_and_output_frames_round_trip_with_sequence_numbers() {
        let start = ServerMessage::Start {
            run_id: "run_1".into(),
            attempt: 1,
            adapter_kind: "codex-cli".into(),
            program: "/opt/bin/codex".into(),
            args: vec!["exec".into(), "hello".into()],
            cwd: "/work".into(),
            env: vec![],
        };
        let json = start.to_json();
        assert!(json.contains("\"type\":\"start\""));
        assert!(json.contains("\"adapterKind\":\"codex-cli\""));
        assert_eq!(serde_json::from_str::<ServerMessage>(&json).unwrap(), start);

        let output = ClientMessage::Output {
            run_id: "run_1".into(),
            stream: OutputStream::Stdout,
            seq: 1,
            data: "TE9PTV9CMV9PSwo=".into(),
        };
        let json = output.to_json();
        assert!(json.contains("\"seq\":1"));
        assert!(json.contains("\"stream\":\"stdout\""));
        assert_eq!(
            serde_json::from_str::<ClientMessage>(&json).unwrap(),
            output
        );
    }
}
