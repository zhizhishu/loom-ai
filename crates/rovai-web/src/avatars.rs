//! Authenticated compound avatar resources; no client path is accepted.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarRequest {
    action: AvatarAction,
    request: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum AvatarAction {
    Read,
    Save,
}

pub async fn avatar(State(state): State<WebState>, Json(body): Json<AvatarRequest>) -> Response {
    let Ok(_permit) = state.uploads.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "resource_capacity");
    };
    let method = match body.action {
        AvatarAction::Read => "memberAvatars.read",
        AvatarAction::Save => "memberAvatars.save",
    };
    match tokio::time::timeout(
        Duration::from_secs(30),
        state.core.request(method, body.request),
    )
    .await
    {
        Ok(Ok(reply)) if reply.error.is_none() => Json(reply.result).into_response(),
        Ok(Ok(_)) => error(StatusCode::BAD_REQUEST, "invalid_avatar"),
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "avatar_unavailable"),
    }
}
