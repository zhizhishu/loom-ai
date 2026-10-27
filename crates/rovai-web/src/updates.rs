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
    Download { version: String },
    Install { version: String },
}
pub type UpdateFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
pub trait UpdateHost: Send + Sync {
    fn call(&self, request: UpdateRequest) -> UpdateFuture<'_>;
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
