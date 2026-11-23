// rakazo@51ff52e infra/updater/src/updater-logic.ts:106-119 (default-off interval), structural comparison; PiBot@6741737 web/src/ClientUpdateSection.tsx:105,218 / ClientUpdateProvider.tsx:134,147-155, structural comparison; label 「自动检查更新」: 无参考，按用户定.
//! Authenticated, closed Server update operations. Desktop never supplies this capability.
use crate::{WebState, error};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum UpdateRequest {
    Get {},
    Check {},
    SetAutoCheck { enabled: bool },
    Download { version: String },
    Install { version: String },
}
pub type UpdateFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
pub trait UpdateHost: Send + Sync {
    fn call(&self, request: UpdateRequest) -> UpdateFuture<'_>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auto_check_operation_is_strictly_typed() {
        assert!(
            serde_json::from_value::<UpdateRequest>(
                json!({"operation":"setAutoCheck","enabled":true})
            )
            .is_ok()
        );
        for value in [
            json!({"operation":"setAutoCheck"}),
            json!({"operation":"setAutoCheck","enabled":"true"}),
            json!({"operation":"setAutoCheck","enabled":false,"url":"ignored"}),
        ] {
            assert!(serde_json::from_value::<UpdateRequest>(value).is_err());
        }
    }
}
pub(crate) async fn request(
    State(state): State<WebState>,
    body: Result<Json<UpdateRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if state.channels.is_some() {
        return error(StatusCode::NOT_IMPLEMENTED, "updates_unsupported");
    }
    let Some(host) = &state.updates else {
        return error(StatusCode::NOT_IMPLEMENTED, "updates_unsupported");
    };
    let Ok(Json(request)) = body else {
        return error(StatusCode::BAD_REQUEST, "operation_not_admitted");
    };
    match host.call(request).await {
        Ok(value) => Json(json!({"result": value, "error": null})).into_response(),
        Err(code) => error(StatusCode::CONFLICT, code),
    }
}
