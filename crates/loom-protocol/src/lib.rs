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

/// One in-flight run the node still knows about when it reconnects.
/// `sent_seq` is the highest sequence the node has assigned, 0 when none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReport {
    pub run_id: String,
    pub attempt: u32,
    pub process_alive: bool,
    pub sent_seq: u64,
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
        /// Empty on the first connection. On reconnect, every run the node
        /// still has, including a process that already exited if its exit
        /// frame has not been acknowledged.
        #[serde(default)]
        runs: Vec<RunReport>,
        /// Host name of machine B. Empty when the node could not read one.
        /// Older nodes omit it; the server keeps the generated display name.
        #[serde(default)]
        hostname: String,
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
    /// The node refused a start. No process was created.
    Rejected {
        run_id: String,
        attempt: u32,
        code: String,
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
        /// Per-run credential for the `rovai` shim. Not the node token.
        shim_token: String,
    },
    /// Keep the existing process. Retransmit output with `seq > acked_seq`.
    Resume {
        run_id: String,
        attempt: u32,
        acked_seq: u64,
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
            shim_token: "run-token".into(),
        };
        let json = start.to_json();
        assert!(json.contains("\"type\":\"start\""));
        assert!(json.contains("\"adapterKind\":\"codex-cli\""));
        assert!(json.contains("\"shimToken\":\"run-token\""));
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

        let resume = ServerMessage::Resume {
            run_id: "run_1".into(),
            attempt: 1,
            acked_seq: 4,
        };
        for frame in [
            resume.to_json(),
            ServerMessage::HeartbeatAck.to_json(),
            ServerMessage::Welcome {
                node_id: "node_1".into(),
            }
            .to_json(),
            ServerMessage::Ack {
                run_id: "run_1".into(),
                seq: 1,
            }
            .to_json(),
            ServerMessage::Error {
                code: "token_revoked".into(),
            }
            .to_json(),
        ] {
            serde_json::from_str::<ServerMessage>(&frame)
                .unwrap_or_else(|error| panic!("{error} in {frame}"));
        }

        let heartbeat = ClientMessage::Heartbeat {
            run_ids: vec!["run_1".into()],
        }
        .to_json();
        let parsed = serde_json::from_str::<ServerMessage>(&heartbeat);
        let message = parsed.expect_err("client heartbeat must not decode as a server frame");
        assert!(
            !message.to_string().contains("shimToken"),
            "heartbeat parse blamed shimToken: {message} in {heartbeat}"
        );

        let json = resume.to_json();
        assert!(json.contains("\"type\":\"resume\""));
        assert!(json.contains("\"ackedSeq\":4"));
        assert_eq!(
            serde_json::from_str::<ServerMessage>(&json).unwrap(),
            resume
        );
    }
}
