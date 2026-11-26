//! Ephemeral Pi dialogs. No durable approval or projection owns these requests.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionUiRequest {
    pub id: String,
    pub method: String,
    pub title: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub prefill: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExtensionUiAnswer {
    pub thread_id: String,
    pub agent_run_id: String,
    pub execution_epoch: i64,
    pub host_instance_id: String,
    pub request_id: String,
    pub value: Option<String>,
    pub confirmed: Option<bool>,
    pub cancelled: Option<bool>,
}

impl ExtensionUiRequest {
    pub fn parse(message: &Value) -> Result<Self> {
        ensure!(message["type"] == "extension_ui_request", "not a Pi dialog");
        let request: Self = serde_json::from_value(message.clone())?;
        ensure!(
            !request.id.is_empty() && request.id.len() <= 256,
            "invalid Pi dialog id"
        );
        ensure!(
            matches!(
                request.method.as_str(),
                "select" | "confirm" | "input" | "editor"
            ),
            "unsupported Pi dialog"
        );
        ensure!(
            serde_json::to_vec(message)?.len() <= 64 * 1024,
            "Pi dialog too large"
        );
        if request.method == "select" {
            ensure!(
                !request.options.is_empty() && request.options.len() <= 64,
                "invalid Pi options"
            );
        }
        Ok(request)
    }

    pub fn response(&self, answer: &ExtensionUiAnswer) -> Result<Value> {
        ensure!(answer.request_id == self.id, "Pi dialog request mismatch");
        let mut response = json!({"type": "extension_ui_response", "id": self.id});
        if answer.cancelled == Some(true) {
            ensure!(
                answer.value.is_none() && answer.confirmed.is_none(),
                "ambiguous Pi cancellation"
            );
            response["cancelled"] = json!(true);
        } else if self.method == "confirm" {
            ensure!(answer.value.is_none(), "confirm expects confirmed");
            response["confirmed"] = json!(answer.confirmed.context("confirmed is required")?);
        } else {
            ensure!(answer.confirmed.is_none(), "dialog expects value");
            let value = answer.value.as_ref().context("value is required")?;
            ensure!(value.len() <= 64 * 1024, "Pi answer too large");
            if self.method == "select" && !self.options.contains(value) {
                bail!("Pi answer is not an offered option");
            }
            response["value"] = json!(value);
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lowest-cost owner of the newly supported wire forms; no Core/DB fixture.
    #[test]
    fn dialogs_construct_exact_responses_and_reject_wrong_ids_or_shapes() {
        for (method, fields, expected) in [
            ("select", json!({"value":"B"}), json!({"value":"B"})),
            ("input", json!({"value":""}), json!({"value":""})),
            (
                "editor",
                json!({"value":"one\ntwo"}),
                json!({"value":"one\ntwo"}),
            ),
            (
                "confirm",
                json!({"confirmed":false}),
                json!({"confirmed":false}),
            ),
            (
                "confirm",
                json!({"confirmed":true}),
                json!({"confirmed":true}),
            ),
        ] {
            let request = ExtensionUiRequest::parse(&json!({
                "type":"extension_ui_request", "id":"native-1", "method":method,
                "title":"Question", "options":["A","B"]
            }))
            .unwrap();
            let base = json!({"threadId":"thread", "agentRunId":"run", "executionEpoch":2,
                "hostInstanceId":"host", "requestId":"native-1"});
            let mut input = base.clone();
            input
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            let mut wire = json!({"type":"extension_ui_response", "id":"native-1"});
            wire.as_object_mut()
                .unwrap()
                .extend(expected.as_object().unwrap().clone());
            assert_eq!(
                request
                    .response(&serde_json::from_value(input.clone()).unwrap())
                    .unwrap(),
                wire
            );
            input["requestId"] = json!("stale");
            assert!(
                request
                    .response(&serde_json::from_value(input).unwrap())
                    .is_err()
            );
            let mut cancel = base.clone();
            cancel["cancelled"] = json!(true);
            assert_eq!(
                request
                    .response(&serde_json::from_value(cancel.clone()).unwrap())
                    .unwrap(),
                json!({"type":"extension_ui_response", "id":"native-1", "cancelled":true})
            );
            cancel["value"] = json!("B");
            assert!(
                request
                    .response(&serde_json::from_value(cancel).unwrap())
                    .is_err()
            );
            let mut wrong = base;
            wrong["value"] = json!("not offered");
            wrong["confirmed"] = json!(true);
            assert!(
                request
                    .response(&serde_json::from_value(wrong).unwrap())
                    .is_err()
            );
        }
        for bad in [
            json!({}),
            json!({"type":"extension_ui_request", "id":7, "method":"input", "title":"Q"}),
            json!({"type":"extension_ui_request", "id":"x", "method":"select", "title":"Q", "options":[]}),
        ] {
            assert!(ExtensionUiRequest::parse(&bad).is_err());
        }
    }
}
