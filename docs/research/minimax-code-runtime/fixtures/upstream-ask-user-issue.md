# ACP: provide a process-local opt-out for questionnaire tools

## Problem

An ACP host without a questionnaire UI needs to omit `ask_user` and
`request_feature_enable` from the model's tool catalog. Dismissing a questionnaire
after invocation is too late: it can leave a turn without an answer. A generic
execution-permission policy must also avoid treating questionnaire `allow_once`
options as permission to choose an answer for the user.

`askUser.enabled: false` works, but changing the shared `config.yaml` affects the
user's ordinary MiniMax Code usage. The published 0.6.12 ACP command has no local
config or tool-exclusion switch. `--config` is available to exec, not ACP.

## Proposed interface

Add an ACP-only process policy such as `MCODE_DISABLE_ASK_USER=1` (an explicit CLI
flag would also work). It must override the runtime config getter in memory on
every read, without mutating the original config object or the underlying file.
Keep authentication, providers, native data directories, Session IDs and normal
file/command/MCP approval behavior unchanged.

A seven-line implementation candidate against public commit
`9a935605956c4500e9cb415f29258e2887e97817` is attached separately. The patch uses the public
CLI lifecycle's existing config getter, so permission-triggered cache resets
continue reading updated provider settings while retaining the process policy.

## Validation performed

On macOS arm64, built the public source (which reports 0.6.5) and used a local
deterministic model endpoint to verify the actual model-facing tool catalog:

1. Ordinary ACP exposes both tools when the native configuration enables them.
2. The process opt-out removes both tools after loading the exact same Session.
3. The normal permission setter still refreshes changed endpoint/key settings on
   the same PID and Session; both questionnaire tools remain absent.
4. A new process loads the exact same Session with the opt-out still applied.
5. Starting ordinary ACP without the policy exposes the tools again. The native
   `askUser.enabled` setting remains true throughout.

The existing CLI help/default-config/ACP-initialize smoke tests also pass.
These are source-patch tests, not evidence that the published 0.6.12 package
already supports this interface. Public source and npm versions differ, so the
candidate has not been substituted for the published CLI in the product.

Would you accept an ACP-local policy interface and carry it into the published
package? We can adapt the small patch to the preferred flag or capability shape.
