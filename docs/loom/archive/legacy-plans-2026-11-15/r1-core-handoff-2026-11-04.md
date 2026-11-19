# R1 Core authoritative remote execution — in progress

Date: 2026-11-04. Owner: mindkit supervisor. Root owns final acceptance and commits.
This is an implementation handoff, not an end-to-end PASS claim.

## Accepted architecture

Core keeps the existing Delivery → AgentRun claim → native adapter → permission / steer / terminal flow.
Node owns a persistent process and ordered byte pipes. A pipe-written receipt does not prove native input acceptance.
RemoteProcessKey(node, process, process_epoch) and AgentRunOwner(run, execution_epoch) are different lifetimes; bundle attempt is a third identity.
A restarted Core does not reconstruct in-memory native adapter state or replay ambiguous input automatically.
Cross-Run Host reuse requires native idle, the old Built-in Tool lease revoked, and a confirmed pipe boundary before binding the new owner.
A's provider environment, auth files, private file paths, or first-Run B4 shim token must not be exported as a persistent remote Host credential.

## Sources added

- crates/rovai-core/src/remote_process.rs: typed target, stable Host scope, explicit non-secret environment, materialized bundle arguments, authenticated receipt checks, bounded termination and bounded startup.
- crates/rovai-core/src/runtime_process.rs: thin Local(ManagedProcess) / Remote wrapper with boxed IO. Remote PID and local Job name are absent; remote exit status is represented separately. Driver integration remains to be completed.

No shared Core lib/application/db file is changed by this owner yet. B7's independent gate owns those until released.

## Verification already run

The exact remote_process.rs source compiled through an isolated artifact manifest on the Windows GNU toolchain.
Initial 4 tests passed, 0 failed, 0 ignored, command exit 0. Evidence:
`_artifacts/r1-core-audit-20261104/transport-check/result.json`.

Those tests cover wrong node/epoch receipts, owner boundary refusal, leader-exit versus tree-stop distinction, unknown Drop only queuing stop, rejected deserialized credential environment, rejected unmaterialized source path, and bundle digest/identity.
Subsequent cached-termination/startup-deadline additions require the next rerun; do not reuse the initial 4/4 as their acceptance.

Reproduction environment: child PATH prefix `target/gcc16/mingw64/bin`, `CARGO_BUILD_JOBS=2`.
Command: `cargo test --offline --manifest-path _artifacts/r1-core-audit-20261104/transport-check/Cargo.toml --lib -- --nocapture`.
The fixture uses a path module to the actual source, not a copied implementation.

## Pi supervision

Readonly Pi session: `1282efebb55441d3b29baeba9e719867`.
Transport/lease trace: `trace-a25335f4522140b1990ccb6a118ee931.json`.
Target/claim trace: `trace-43502c906a0c42108b5ad1f29fbe91fb.json`.
Both completed exit 0; these are research reports, not test evidence.
Supervisor rejected two suggestions: failed explicit remote selection must never fall back to local; loom_claim.claim_id is a primary key and can be referenced.

## Concrete integration gaps under implementation

1. Production Delivery batching creates the real AgentRun; legacy run.task_id is NULL and belongs to a different Task model. LOOM task identity needs its own binding.
2. loom::claim_acquire currently accepts an AgentRun ID without proving Run/member/mission existence. A remote claim must prove all these under Core's transaction and must not depend on a caller-supplied string.
3. Freeze member host selection when Delivery creates the Run, so later member saves affect the next Run. Validate node/catalog and bind the claimed execution epoch in claim_agent_run's transaction.
4. Delivery runtime resolution and Mission workspace preparation, dispatch preflight, adapter launch, native-session compatibility and Fleet ownership still assume local paths. All need explicit remote branches.
5. BuiltinToolProcessConfig already separates a stable process token from per-Run lease_id/generation/token. Remote IPC must resolve current auth at A after validating remote process + owner + binding sequence. Existing bind checks local is_dir and needs a typed remote workspace branch.
6. Existing artifact registration hashes actual controlled files on A. Remote bytes must be bounded, archived, and independently hashed before registration; a remote claimed hash alone is insufficient.
7. Native H and a real mission/task/claim/AgentRun/node/artifact/independent-review run are still required. Source fixtures do not close R1 L-C01E or multi-node concurrency.

## File ownership

R1 migration 231 reserved. Root owns process-pipe protocol/Node actor; four-ends owns native process-boundary crate; loom supervisor owns B7/B8 and will connect Hub after B7.
No real memory, daily Rovai database, provider credential or user's project output was accessed by these tests.

## Progress 2: Core bridge and authoritative target registration

The earlier “shared Core unchanged” description describes Progress 1 only.
After B7's owner released Core seams, this batch registered the public typed
remote process/catalog/execution/services modules and the internal runtime
process wrapper. CoreService can install one trusted Rust transport, reuse the
same provider across Web restart, and invoke the authenticated remote Built-in
Tool bridge. This is not a JSON process-launch API.

Evidence:
- _artifacts/r1-core-audit-20261104/core-check-1/result.json: full
  cargo check --offline -p rovai-core --lib, exit 0, 274.42 seconds.
- _artifacts/r1-core-audit-20261104/transport-check-2/result.json: actual
  remote_process source, 6/6 tests, zero ignored, exit 0; source SHA unchanged
  before/after: 0a3351da31eec44c5ffbeba46f2b309af9357c49aa7ed80b21808128a286d696.
  It proves initial owner sequence 0, monotonic replacement, stale receipt
  refusal, bounded launch/initial binding, and positive tree-stop acknowledgement.
  It does not prove a native remote Run.

New code after that full check still requires the next gate:
- migration 230/projection 180 for the R2 workspace RPC journal, followed by
  migration 231/projection 181 for remote catalog fields, member selection,
  immutable real-AgentRun targets and LOOM claim target facts.
- Core member endpoints members.executionTarget.get and .save; selection
  saves are immediate transactions with CAS revision, explicit null=local,
  and closed DTOs. Fixed error codes do not return SQL or path details.
- The supplied workspace root is only compared to the ready Core
  mission_workspace record. Active workspace-camp membership, owner node,
  root, workspace generation and preparation token digest are revalidated.
  No A filesystem probe establishes a B path.
- Runner completion/abandonment closes remote services to break the provider
  ownership cycle. Listener restart does not close them. Dropping a provider
  never counts as confirmed process termination.

Pi worker 8cdd6fd110c84c45894435842b1a2071 first read the exact three native
freeze seams, then received a write whitelist for agent_profile.rs,
delivery_queue.rs and runtime.rs. Its draft is pending independent review and
tests. The supervisor owns application.rs, db.rs, remote modules and migration
adapters. No daily database, real memory, credentials or global rules were used.

Still open: actual native driver transport integration; authoritative Core
bootstrap and selected B7 bundle materialization; remote Built-in lease call
sites; single bounded R2 byte read and A-side artifact archive; native real
AgentRun/claim/completion E checks. Remote loom.evidence is explicitly refused
until the byte archive path is connected. No R1 end-to-end PASS is claimed.

## Progress 3: recovery and one-transaction source capture (2026-11-05)

AgentDock returned successfully after the interruption. The prior command
session-e1b8f753993fb0f98757427c no longer exists; core-gate-2 exists but has no
results or stdout/stderr files. Windows process inspection found no surviving
cargo/rustc/rustfmt or owned core-gate process. This interrupted gate has no
acceptance result and must not be counted as PASS. Its empty directory is kept.

The source capture module now exposes capture_in_existing_transaction. It
requires an already open SQLite transaction, never begins/commits/rolls back
that transaction, and preserves the previous bounded, key-free file/MCP capture.
The standalone capture entry keeps its own read transaction and before/after
database stamp. The existing catalog owner now checks autocommit refusal,
preservation of the caller's transaction, zero DB writes, and equal source
digests. These new assertions are pending the recovered Core gate.

R1 member get now returns authorized ready availableWorkspaces and pure runtime
descriptors with the actual existing permission defaults. Claude has an initial
RuntimeProcess launch helper, but App dispatch has not called it yet. These are
implementation changes awaiting compile/test evidence, not a claim of a usable
remote native AgentRun.

## Progress 4: compile counterexamples and owned control futures

Recovered Core gate 3 failed in compilation: Cargo exit 101 after 279.468 s;
no test ran. Its before/after tracked source hashes matched. Evidence:
_artifacts/r1-core-audit-20261104/core-gate-3/results.json and 0-stderr.txt.
Failures were the remote cleanup future retaining a shared borrow of non-Sync
boxed IO, SQL u64 conversions in execution_node, and the PRAGMA data_version
stamp type. Loom owns the catalog conversion fix; this owner fixed the control
futures and reads the SQLite stamp as i64.

The exact updated remote_process source passed isolated transport-check-3:
6 passed, 0 failed, 0 ignored, Cargo exit 0, 17.641 s. Source SHA before/after:
42b183fbb2b09f18680fe3a196d5062809404d6f7721bb2fd4a2595a7c11b7b4.
The existing owner now proves that every control future is Send without making
IO Sync, flag-only owner changes need the next binding sequence, and an unbound
process cannot advertise task discovery. This does not accept the full Core.

ScopedRemoteLaunch/RemoteOwnerReceipt and bind_owner now carry the actual
builtin_tasks_enabled flag. Materialization is a narrow bundle identity +
skill-root receipt; Core requires an exact match when a bundle was requested.
A Node-authored prompt is not accepted.

Production Delivery now uses the same IMMEDIATE transaction to capture bounded
capability source, include its digest in target/runtime compatibility, create
the real queued Run, and persist target + immutable source. Migration 231 owns
the source and process-preparation rows. Existing local wrappers remain local;
a saved remote target without explicit source context settles visibly.
The cleanup query now includes authoritative node identity, so identical path
strings on different hosts cannot block each other. These new production
connections still await Core gate 4 and a true native Run.

Pi readonly trace-880d311cc2274179a354d73986ed4785 completed exit 0. Supervisor
accepted the cross-host cleanup defect and investigated native resume boundary.
The proposal to force every authorized workspace into the conversation camp was
rejected: independently authorized chat workspace reuse is intentional; LOOM
claim still enforces its mission/camp. The speculative external DB deletion
scenario was not recorded as a confirmed API defect. The same Pi worker is now
limited to runtime.rs for the metadata-authorized remote resume boundary.


## Progress 5 — real App dispatch and trusted R2 registration (2026-11-05)

- Production DeliveryQueue now captures the selected remote target and bounded capability source inside the existing IMMEDIATE transaction, inserts the real queued AgentRun, and freezes both immutable rows before commit. The existing claimed Context bootstrap is also persisted in that transaction. Source capture has no nested transaction and performs no database writes.
- Core's existing Claude native driver is selected through its new RuntimeProcess transport branch. The actual Core native binding and Built-in Tool lease are prepared before Node Open. Remote startup skips A-side CLI probe, provider environment loading, and workspace existence checks; it uses only the frozen Node catalog/workspace and key-free materialized bundle. builtin_tasks_enabled comes from the actual lease refresh. The private process-preparation row proves preparation, not native acceptance.
- R2's actual transport/authority/application modules are registered. CoreService::install_workspace_rpc_transport installs one shared trusted Arc, rejects replacement with a different Arc, and only the unique Core runner closes it. The common Built-in router authenticates the true Run, applies existing Single Chat policy and start-evidence admission, then releases the database guard before awaiting Workspace RPC.
- Pi's remote native-session resume change was independently read back. It derives local/remote identity from the authority mapping, never identifier prefixes, and permits remote resume only for the same installation/generation/configuration/session compatibility. Supervisor additionally rejected empty or whitespace-only keys/digests. The existing local resume rule is preserved. This owner has not yet been run in the current full Core suite.
- File boundaries are explicit: remote send.files and member.create/update.avatarFile are rejected with remote_file_transfer_required; remote loom.evidence remains blocked until its bounded bytes have been archived by Core. Remote member.get uses the existing avatar.status=unavailable, null path/crop shape rather than advertising an A-side private path. There is no generic Built-in large-result file-offload DTO; the existing Envelope contains JSON. Media transfer is not complete.
- The generic local Run resolver now rejects a saved remote member choice with remote_run_creation_not_connected instead of silently launching local. Mission Delivery uses the dedicated transaction-aware resolver. The independent Single Chat path still needs the same real freeze/claim integration; this rejection is an intermediate boundary, not completion.
- Actual compile evidence: _artifacts/r1-core-audit-20261104/core-integration-probe-4/results.json: cargo check --offline -p rovai-core --lib exited 0 in 220.813 seconds, with the 18 tracked Core source hashes unchanged. This proves the current production App/type connections compile; it is not a test or native end-to-end PASS. The paired cargo build --offline -p rovai-core --bin rovai is still running at this checkpoint, AgentDock session session-443ab953da26530e724fb940.
- The earlier real transport test remains 6/6 PASS; no additional owner or E2E result is claimed here. Next frozen suite must include current migration 230 archive changes from its owner, migration 231, source capture, remote resume, catalog generation, and real Delivery rollback.
- A remaining verified seam: terminal Skill projection reconciliation currently canonicalizes the execution root on A. It must receive the real Run identity and skip remote Run roots before any local canonicalization, so equal-looking paths on two nodes never alias. The helper change is queued after this compile probe.
- Root/LOOM owner received the exact production external harness sequence: application::transport::embedded with explicit isolated CoreConfig, members.list or members.create, missions.create with projectBindingKind=directory, the real Node workspace preparation, members.executionTarget.get/save using actual descriptor permission defaults, then camp.messages.send with Composer V2 member addressing. That route calls the real CollaborationService and wakes DeliveryQueue; no fabricated AgentRun or lease is used.


## Progress 6 — actual helper build and authoritative terminal/claim wiring

- core-integration-probe-4/results.json now contains actual cargo check --offline -p rovai-core --lib exit 0 (220.813 s) and cargo build --offline -p rovai-core --bin rovai exit 0 (425.672 s). Both kept the 18 tracked source hashes unchanged. This is an integration compile probe, not final frozen acceptance of the later R2/45 work.
- target/debug/rovai.exe SHA256 83272947281db15b54017ae01c4f06ae13138be4aa2e04c1e4fe84277dd602eb. Actual --version exit 0: rovai 0.5.1 contract-v44 ipc-v3. helper.json records it; final v45 must be rebuilt.
- Actual Core launch now uses the frozen conversation_id for RemoteHostScope.logical_session_id and the immutable process preparation row. Native binding ID remains a distinct Core lease identity; the preparation validates the binding installation without substituting it for the conversation.
- LOOM claim_acquire now validates the real Run/source/current epoch/active member/Mission/workspace/explicit Task node before any claim write, then records loom_claim_execution_target in the same IMMEDIATE transaction. Cancelled and orphaned remote authority are rejected with LOOM_REMOTE_TARGET_UNAVAILABLE; existing exact-command replay keeps its original receipt semantics.
- Terminal Skill reconciliation now takes actual agent_run_id at all 11 callers. It resolves a path only from a proved local installation and Run, and skips remote, absent or damaged authority before A filesystem access. Added a tiny SQL regression owner for equal root strings on different host authorities. New changes are written but not yet tested; no new PASS claim.
- Pi artifact-only Delivery owner draft is under supervisor correction. Incorrect expectations about the generic resolver and same-conversation pending cleanup were rejected; no production tests were blindly applied.
- Two explicit follow-ups: (1) remote LOOM evidence must store an archive locator and verify A-owned bytes through the typed R2 journal, with explicit trusted data_dir; (2) mission_workspace.worktree_path remains globally UNIQUE, while local execution_directory/context branch queries need host scoping before supporting same-string roots on several Nodes. Historical-table rebuild proposal has been sent to root for review; no such migration has been applied.


## Progress 7 — supervised workspace migration and first Claude E source freeze

- Pi produced db_remote_workspace_scope.rs in session 8cdd6fd110c84c45894435842b1a2071, trace d4eacffb2c594fda9308c8851b0aa94d. Supervisor reviewed the entire source and corrected incomplete CHECK/index admission and misleading NOT NULL failures in UNIQUE tests.
- Actual independent native Rust test: workspace-scope-check/result.json, exit 0, 2 owners passed, 0 failed/ignored, 33.859 s including compile. Source SHA256 198720e2ab4e80ea9d0f04428285cd1a7d80670a1e4ea570a8a90973c4c11457, unchanged during test. The separate doc-test target has 0 cases and is not counted.
- Migration now preserves the actual stored CREATE declaration and all 23 columns, validates complete declarations/CHECK/default/PK/index shape, rejects unknown columns/indexes/triggers/external FK references, copies inside the caller transaction, compares COUNT plus bidirectional EXCEPT, then replaces only path uniqueness with (execution_host_id,worktree_path). Partial/unique/DESC/NOCASE cleanup indexes are refused. Historical column reordering is tested.
- The module is registered in migration 231 and current schema admission. The existing current-database admission owner now includes a real 180 receipt + historical workspace table -> actual migration231 replay, retained-row checks, FK check and cross-host/same-host path cases. These full-Core tests are written but have not run yet.
- Local execution_directory is explicitly scoped to mission_execution_host. Context branch lookup uses the actual Run's frozen Node (or local host). Remote Delivery preflight supplies its validated workspace fact from the same creating transaction, before the Run target row exists.
- Pi's Delivery draft was corrected before applying: fixed SQL bind-number bug, removed false capability-digest-change expectation when only model selection changes, and added real Delivery-created Run -> scheduler claim -> LOOM claim binding, rollback trigger, cancellation and exact replay tests. Same-string local/Node workspace and remote branch isolation extend the existing Mission claim owner. No claim of PASS until the full owner runs.
- core-claude-e-freeze.json records this first-Claude-E source batch. Claude production App is connected; Codex Host/App and Single Chat remote creation remain explicit work in progress. Root now owns codex.rs transport implementation; this supervisor owns App lease-before-Open and single-chat integration. Loom supervisor owns unified build and the first actual A+B+Claude Mission E. Remote LOOM evidence archive consumption is subsequent work; R2 typed archive bytes are already available.

## 进度 8 — 第一份产品构建后增量（2026-11-05）

首轮联合产品构建由 LOOM owner 完成：exit 0，422.969 秒，407 个源码输入前后无变化；该固定二进制仍只用于首轮 Claude E。首 E 停在 Node online/CLI catalog 等待门，尚未创建成员或实际 Run，不能据此宣称 R1 运行成功或失败。

本批已修改但尚待编译/运行验收：application/mission.rs 本地准备只读取当前 mission_execution_host 的 workspace，避免 B 已准备行抑制 A 本地工作区；Codex App 生产路径复用 Root 新 RemoteRuntimeLaunch/RemoteAgentThread API，冷启动在 Open 前建立真实 Core lease，warm 使用实际 Host config/key 重绑当前 Run；兼容摘要包含冻结 source/configuration，未包含每 Run bundle ID；所有 Open 后错误统一经过 Stop，远端 replacement 明确要求新 launch。agent_run_remote_process 的不可变准备记录键扩展到 process key + Run/epoch，并对同 owner 重复准备核对 bundle digest；该行仍仅证明 preparation。

Core probe 5 已启动（session-e3da30137e022805c71c167b），结果目录 _artifacts/r1-core-audit-20261104/core-integration-probe-5。在 results.json 和实际非零测试计数完成前，不标 PASS。3 个 App 本机 Codex test literals 已跟随 optional factory 字段更新。

SingleChat 的本地 Pi 只读复核已完成（Pi trace c011b4cfc3224d0fbde984621b495335，未运行测试）；报告保存在同专项 artifact。监督结论：需保持命令 replay 短路、原 queue-only 条件、queued epoch 0 的专门 bootstrap 读取以及 missing remote bootstrap 明确拒绝；不采用增加“远端暂时失败自动入队”的额外行为。MessageChanges::begin 已由 supervisor 实读，只有线程局部内存操作，没有 SQL 写。SingleChat 真实接线与 LOOM remote artifact 仍未完成。


## Progress 9 — Single Chat and live remote capability integration (2026-11-05 UTC)

- Core integration probe 5 finished with exit 101 at library check. Source inputs remained unchanged. Its four diagnostics were the same non-Sync local cleanup borrow in the new Codex host, not a passed runtime test. Root's subsequent two-file fix is recorded separately in codex-transport-fix2/result.json.
- Real Single Chat send/publish now reuse the existing command gateway. Existing receipts replay before source capture; queue-only sends do not require a currently usable source. Actual new Run admission freezes the trusted remote target, source and a bounded Single Chat Bootstrap in the same command transaction. The queued snapshot reader preserves the private-chat policy and refuses a missing remote snapshot instead of reading future member state.
- F13 capability refresh shares the native owner-binding gate, reads the current tasks flag inside that gate, and rejects stale Run owners. Remote startup reads the live Core capability before Open and synchronizes again after installing the control handle; failed post-Open installation/sync requests confirmed cleanup. No Core credential or A filesystem path is sent to B.
- Warm Codex preparation now unregisters a discarded speculative process registration, while retaining the actual warm Host's lease. The persistent Node MCP materialization change is independently owned and tested by the LOOM supervisor.
- A local Pi worker wrote only a test draft. Supervisor review corrected its active-lane rollback ordering, Accepted queue status, actual ready_pending_inputs publish command, and actual Runtime completion helper; no unimplemented placeholder was applied. Existing owners now exercise rollback/retry/replay, source-unavailable queueing, new-Run publication, and explicit attachment rejection. Existing remote-process owner adds delayed capability and stale-owner counterexamples.
- Twelve owned source files passed rustfmt. No new runtime or owner PASS is claimed yet. Probe 6 is running as session-e282cd0326e3e91f0ba96110; its incremental results are in _artifacts/r1-core-audit-20261104/core-integration-probe-6/results.json. Core and dependency sources are frozen until that gate ends.
- The fixed joint-build-1 binaries remain distinct from these later sources. Its first native E attempt stopped before Node admission; the second stopped before Mission creation because the fixture omitted the existing workspaces.validate canonical-path grant step. Neither attempt reached an R1 Run and neither is counted as an R1 success.


## Progress 10 — 2026-11-05: product 2 and actual Core owners

- Core probe 6 compiled the actual library (cargo check, exit 0) and extended test executable (--no-run, exit 0); 321 tracked source hashes stayed unchanged. The subsequent Cargo-launched first owner timed out waiting for the build-directory lock and ran no tests. This is not an owner PASS.
- The same compiled native Windows executable (SHA256 8818d858e745f87109f6a77daa1c86995d1bbc0b54f5ecfafbea927c4d97b92b) was then run directly, single-thread, with fixtures under this project. Remote-process 6, SingleChat send 1, SingleChat pending publish 1, and Codex remote line handling 4 passed (12 actual PASS; zero ignored). Source hashes before/after stayed unchanged.
- The Mission claim owner then failed at delivery_queue.rs:5877: it compared a raw Windows path with the JSON-rendered WORKSPACE text. The production formatter serializes this block with serde_json::to_string, which escapes backslashes. The next batch will parse the sole WORKSPACE block and assert the complete typed value rather than weaken the path assertion.
- The separately resumed database admission owner executed its current-contract checks and real 180-to-231 workspace migration helper, then failed at its final production reopen (db.rs:44363): the fast-copy test fixture root had inherited Windows ACLs. The production private-directory guard correctly refused it. The next batch will create this fixture through the production database-opening path; no ACL enforcement will be relaxed.
- Original failed logs and precise command counts remain in _artifacts/r1-core-audit-20261104/core-integration-probe-6/{direct-owners,direct-owners-remaining}. Remaining independent owners continue against this same compiled executable; their results are not yet claimed here.
- The Unix-only Codex dynamic environment owner remains BLOCKED: the new-source Linux transfer was rejected by automatic approval. Windows zero-test output, WSL, or another upload route will not substitute for it.
- Loom supervisor reports joint product build 2 exit 0 with all 408 source hashes unchanged. Its fixed Host/Node/helper binaries are the separate native E baseline. Production source has been released for a new batch.
- Remote LOOM artifact support is prepared only under _artifacts/r1-core-audit-20261104/remote-artifact-staged: 6 staged files, rustfmt exit 0, independent Pi read-only review running. The proposed unshipped migration 231 increment is explicitly approved by root: host-origin uniqueness and immutable archive locator, no artifact table rebuild, no public CLI/DTO change. Fifteen isolated SQLite constraint checks passed against the staged SQL; this is not yet production migration or native E acceptance.


## Progress 11 — 2026-11-05: artifact publication and review fixes

- The remaining original compiled owners passed: terminal host authority 1, resume target 1, frozen bundle source 1, persistent catalog generation 1, and integrated Workspace RPC 14 (18 PASS, zero ignored). Together with Progress 10 this is 30 actual PASS, with the two original Windows fixture failures retained. Evidence: core-integration-probe-6/direct-owners-final/results.json; all 321 source hashes stayed unchanged for that binary. The Unix-only environment owner remains BLOCKED.
- A new production batch is now applied in exactly loom.rs, loom/remote_artifact.rs, db_loom.rs, db_remote_execution.rs, db.rs, delivery_queue.rs, application.rs, and application/remote_runtime.rs. Before-copy checks and backups are in remote-artifact-staged/before-apply and applied.json. Current eight-file hashes and rustfmt exit 0 are in production-format-review-fixed.json. No build/test PASS is claimed for this new batch yet.
- The existing authenticated loom.evidence operation now performs a complete bounded R2 read, uses the retained completed receipt and actual Core archive bytes, and atomically stores an immutable artifact plus archive locator. Origin is derived only from the real frozen Node/workspace identity. The unshipped migration 231 adds origin-scoped uniqueness and locator guards without rebuilding loom_artifact or changing the public CLI/DTO.
- Registration snapshots retained metadata under a short DB lock, performs both current/previous archive reads and hashes in spawn_blocking without the DB mutex, then revalidates current Run/epoch/claim, receipt, and locator under the publishing transaction. A racing newly inserted artifact is refused until its own locator has been verified. Remote Task replay requires the same taskId.
- Pi read-only review is preserved in remote-artifact-staged-review.md (session a1a26bd48f044ce880bddddb8d26dd19; no tests run). The confirmed error-mapping gap is fixed using the existing map_domain_error and agent-code mapper. Pi's suggestion to send upper-case domain codes directly was not adopted. Stale target failures use existing actionable LOOM errors. The actual production verifier is now archive-aware; the legacy direct library entry point remains local-only and fails closed for remote evidence.
- The existing real Delivery/Runtime/Task-claim owner now also exercises actual SQLite request events, private archive publication, registration/replay, forged receipt and epoch rejection, origin/locator immutability, same-path origin uniqueness, publication rollback, retained verification after producer completion, snapshot races, and the actual Candidate/Review/Verification functions. These additions are awaiting native execution; the deterministic events are S evidence, not a substitute for the live Node transport.
- The failed WORKSPACE owner now parses the unique JSON section and compares the full typed fact. The database preflight fixture now obtains a production CoreDataDirLease, Initializable admission ticket, and Database::initialize_new before its final production reopen; the test-only raw Database::open and fast-copy helpers do not replace that storage contract.
- The fixed joint product 2 binaries remain the native E baseline. Loom supervisor owns the Node Windows path correction and next Mission E. Root assigned this owner the subsequent SingleChat native E, to use real public APIs and immutable source/Run evidence after the next Core gate.


## 进度 12：真实编译检查与隔离归档 owner 的单行修复

- Core probe7 production check 实际 exit 0 / 99.343 秒；extended test 编译 exit 101 / 157.657 秒，唯一错误是新增隔离归档 fixture 将 archive_snapshot 的 Connection 传为只读引用。330 个实际依赖源 SHA 前后不变；该轮未执行任何 owner，不记整体验收 PASS。
- 仅将该 cfg(test) 调用改为 database.connection_mut()，rustfmt exit 0。remote_artifact.rs 更新 SHA 023b0a347f89f115739c01b61e93050b0e9f582f851b775ff9c732a7ac13168e；旧失败证据保留于 core-integration-probe-7/results.json。
- probe8 在新的 core-integration-probe-8 目录运行：extended lib test --no-run，然后直接运行实际新 test exe 的 Mission claim/归档、生产 schema preflight、LOOM domain/schema 三组既定 owner。测试计数必须非零，实际二进制与依赖源 hash 记录；本条写入时尚未完成。
- 新建隔离 _artifacts/windows-e2e/single_chat_e2e.py，只走公开 open/send/end、真实私聊 Run 和原生 helper。计划验证 private policy、真实 Node 冻结目标及 pending 输入自动生成第二 Run。仅语法检查通过，Pi reviewer 正只读核 DTO/authority/marker，尚未原生执行。
- E6 的 accepted_input_outcome_unknown 已核：Core 在实际 stdin shutdown 回执后等待真实 Exit，超时按失败记录；不改 Core 超时、不把 force cleanup 当成功。Node writer 真实 EOF 由 Root 持有修复。单聊 E 等此闭环及 probe8 后启动。


## 进度 13：真实 SingleChat 双轮通过；首次 Task 绑定与 Core9 冻结

- SingleChat 原生 E2 实际 exit 0 / PASS：_artifacts/e/sc-1105-050842-763d3/result.json；摘要 _artifacts/r1-core-audit-20261104/single-chat-fixture-review/e2-native-summary.json。固定 Host2/helper45 + 已自然 EOF 修复的 Node，三二进制 hash 与 manifest 已核；四个 fixture 源前后无漂移。
- 公开 singleChat.open/send 创建真实 Run 48681a13-8f74-4c91-873b-e0bdb7851ea4；native CLI 的 mission.get 成功，thread.runs 明确返回 single_chat.operation_denied。首 Run 活跃时第二输入仅进入 pending，没有提前创建 Run；首轮 succeeded 后，调度自动创建 690aa27a-53f6-42d3-bb16-ad01d0c83588，native 工具再成功并最终 succeeded。
- 两轮共用 conversation 9a718f2b-28d7-4886-8c6d-2f5d1eb5489b 和实际 native session d110a361-bd70-449d-a612-e3c940197dc8；Claude 一轮一进程，PID 6028 -> 2104、process key 不同，静态 source digest 相同。公开 end 成功记录 user_ended。自有进程均清理，没有修改日常配置/DB。
- E1 的 SQL 证据列误写 last_error_detail 已保留 FAIL；真实字段改用 public_runtime_failure_json，错误 schema 立即失败，不再由 until 当临时锁错误吞掉。Pi 本轮 reviewer 超时没有最终报告，已保存，不计审查 PASS；复核由 supervisor 完成。

### Core8 实际结果与必要修复

- Core8 extended lib test 编译 exit 0 / 298.016 秒，330 源稳定。Mission 大 owner 跑到取消反例时因测试只设置 cancel_requested_at、未同步 cancel_reason_code 而被真实 CHECK 拒绝；已修成对设置/清除，不改生产 CHECK。
- 固定该实际 test exe（SHA abe6920f92412cc0e7d2f12a181a08888730dd5ca310cdab82b1f4679ebb15f6）补跑：生产 schema preflight 1/1 PASS（包含真实 ACL 初始化/open_admitted 与 180 -> 231）；LOOM domain/schema 72 项中 71 PASS、1 FAIL。
- 剩余历史 fixture 只迁移到 228 / projection 178，却陈旧断言 Current。按 Root 审定改为精确 SupportedMigrationSource(178)，保留迁移序列与后续 Plan 写回；没有改变生产 classifier，也不把旧库称当前库。失败日志均保留。

### 真实 R1 Task 首次领取

- 与 Loom 核对后确认旧 B5 Task pin 只有历史文档手工 SQL，无公开生产写入口。用户已选助手 Node/workspace，真实 R1 Run 已冻结该授权目标；不新增隐藏手工 pin API。
- Root 批准最小方案已落：validate_loom_claim 纯读证明当前 Run/epoch、member、Mission、Task assignment、源与 Node/workspace；NULL Task host 只表示尚未绑定。真正领取通过全部 READY/依赖/活跃租约检查后，在原 IMMEDIATE TX 内以 NULL + revision CAS 绑定该冻结 Node、revision + 1；claim target 保存 post-bind revision。
- 已有异 Node pin 仍拒绝。replay 不写，CAS 或后续 claim-target 插入失败回滚整个领取及 Task 绑定。legacy /nodes/tasks/exec 对 NULL 的拒绝保持。没有新增 RPC/CLI/迁移。
- 扩展既有 Mission owner：首次绑定、纯读准入、错 Node、CAS 失败、后续失败整体回滚、取消、post-bind revision 和 replay；并从实际 catalog -> selection -> prepare -> resolve 构造 Codex 虚拟运行配置，核 Root fix3 的合法 URI 与路径/auth/generation/fingerprint/config/search-generation 六个反例。
- 当前上述新 owner 尚待 Core9，不能用旧 71 PASS 代替。core-integration-probe-9/runner.py 已启动：只编译必要 lib test，运行 Mission/历史219/Codex protocol 四项 owner；成功后同冻结快照构建 Host/helper，复用固定 EOF Node，输出 core9_node_eof1 的组件 manifest。
- 下一步是真实 artifact CLI E：公开原生 Plan/release/claim，同真实 Run 的 R2 完整读取 -> Core 私有归档 -> loom evidence -> submit 引用 artifactId；无 SQL seed 或伪造 Run/lease。


## Progress 14 — Core9 preserved failure; opaque claim getter; Core10 running

- Core9 frozen compile exited 101 (71.391 s), with one actual private-field error in remote_artifact.rs; all 390 source files remained unchanged. Owners and product build did not run. Evidence: _artifacts/r1-core-audit-20261104/core-integration-probe-9/results.json.
- RemoteClaimAdmission remains opaque. The narrow bound_task_revision getter returns the freshly observed Task revision only after its Node binding exists; evidence registration rejects an unbound Task. First successful claim still records the post-CAS revision. Exact backups/hashes and rustfmt exit 0: core9-opaque-admission-fix/result.json.
- Core10 now compiles the extended lib, runs only the required Mission claim/artifact owner, historical 219 fixture and Codex line owners, then builds Host/helper only if all pass. It will combine those binaries with the independently verified EOF Node in bin/core10_node_eof1; no success is claimed before final result and source identity checks.
- Production source stays frozen during this pipeline. Readiness work remains staged outside crates; artifact native E preparation can proceed in independent fixtures.


## Progress 15 — Core10 exact results; build-only Core11; real artifact fixture ready

- Core10 extended test compilation passed in 223.047 s. The combined Mission owner reached the remote archive historical-read stage but failed on a fixture-only Run terminal update lacking ended_at (38.984 s). All 390 sources were unchanged. No product build or whole-owner PASS is claimed.
- The same actually compiled, copied test executable then passed the old219 migration fixture (1/1, 42.688 s) and all four Codex protocol-line owners (4/4, 0.156 s); its SHA remained 7bb4ac08bde13e41ee7e91ed667ba4f4dc5b0e98f7fceda788abf492fe04d0b1. Evidence: core-integration-probe-10/remaining-fixed-binary/results.json.
- The terminal fixture now writes status and ended_at together under its rollback-only savepoint and asserts the prior running/NULL state is restored. Production CHECK constraints remain intact. The remaining owner tail uses canonical candidate/review/verification APIs, not further direct Run-state updates. Evidence: core10-terminal-fixture-fix/result.json.
- Root approved separating isolated native test binaries from release acceptance: Core11 first builds Host/helper with a frozen source manifest, combines the fixed verified EOF Node, and records ownerGate=PENDING plus releaseAcceptance=NOT_ACCEPTED. The required Mission owner will be recompiled and run against that same snapshot. These files are for isolated native tests only, not production rollout.
- Independent artifact_e2e.py is syntactically valid and statically checked by the R2 supervisor. It uses real public Mission execution and real native helper plan/release/claim/evidence/submit; first claim must bind a previously unbound Task from the frozen Run. Its reads independently verify actual Node completion bytes, A private archive bytes/hash, request/content-derived archive ID, immutable locator and candidate content identity. Native execution remains NOT_RUN until new binaries exist.


## Progress 16 — Core11 isolated native binaries built and frozen

- Actual cargo build of rovai-host plus rovai CLI exited 0 in 499.969 s. All 390 tracked source inputs matched before/after. Report: _artifacts/r1-core-audit-20261104/core-integration-probe-11/build-results.json.
- Fixed combination: _artifacts/windows-e2e/bin/core11_node_eof1/manifest.json. Host SHA256 153e4d70639b8b38be98fb4fdb7935fed4acab96be28be4981c8a7d66195f728; helper SHA256 34a7120dd7ed4e90982102a1dca5b32817eb59e00ea18d5e76f270c50061b6e6. Actual helper version probe passed contract-v45 / ipc-v3. Node is the separately verified EOF build, SHA256 32c1f17a6eb2f48372c37e3af3c2cc2df85f5685b98e17365f2309f428b59f15.
- Manifest PASS applies only to this component build. ownerGate remains PENDING and releaseAcceptance is NOT_ACCEPTED; these binaries are for isolated native E, not production rollout or total acceptance.
- Root receives this combination for Codex E2. The artifact native fixture will use the same fixed binaries after cold-start coordination.
- Root approved combining remaining owner compilation with Four's reviewed readiness batch. Core11's prepared owner-runner.py stays NOT_RUN. Production freeze is now released to Four for its precise CAS-applied whitelist, followed by one Core12 extended compile covering the Mission claim/artifact owner and member_execution_availability::tests. Existing old219 and four Codex-line PASS evidence is retained without unnecessary reruns.


## Progress 17 — Real remote artifact CLI chain passed; business acceptance remains separate

- Isolated Windows native E1 exited 0 in 127.853 s using the fixed Core11 Host/helper and verified EOF Node. Full result: _artifacts/e/artifact-1105-053402-ccd66/result.json; summarized identities/hashes: artifact-native-fixture-review/native-e1-summary.json.
- Real public Mission Run 37399266-a324-493a-9b2e-3b2b22fa8b18 executed native helper plan, release, claim, evidence, evidence replay and submit. No SQL Run/claim/RPC event/receipt/artifact seed was used.
- Before first claim the actual Task had no execution host. The successful native claim derived the frozen Node and incremented the Task revision once; the claim target retained the exact real Run/epoch/Node/post-binding revision and configuration digest.
- The native agent wrote the fixture file on B. Its evidence call crossed B native IPC -> A builtin -> A Workspace RPC -> the same B read -> A private archive -> native builtin result. Actual accepted/completed journal events, request/content-derived archive ID, private archive bytes and SHA256, immutable artifact locator, Run/epoch/claim fence all matched. The registered archive contains 84 actual bytes with SHA256 305ef3e50ae3cfb014ac238dcd9ca02150a8af4b20e826cbb0d9f8490905fe63.
- A second actual native evidence call replayed the same immutable artifact. Native submit referenced that artifact ID and retained the independently recomputed candidate content hash. The real Run then reached succeeded with ended_at and no last error or cancellation. The archive remained physically readable with identical bytes after the producer Run ended. All four fixture source hashes stayed unchanged; owned processes were cleaned.
- This proves native submission, not independent business acceptance: candidate verificationStatus remains unverified and acceptanceStatus remains pending. A separate authenticated reviewer/verification E is being prepared; E1 is preserved unchanged.
- The local fixture provider logged two HTTP keep-alive connection resets during connection shutdown. All requested native tool responses were confirmed and the real Run's persisted success was checked; the raw runner stderr is retained rather than hidden.
- Core12 compilation has not started. Root is applying the narrow Node-local CODEX_HOME allowlist fix before the combined frozen Core/readiness gate; no A-provided config-home environment permission is being added.


## Progress 18 — independent Owner acceptance with B offline

Fresh actual native producer Run 5bbfb23e-1963-4092-a75d-9df16e149a5c repeated plan/release/first claim/remote evidence/archive/submit and reached succeeded. This is a separate fixture from Progress 17; the previous submission evidence remains unchanged.

The native process tree exited and Node release acknowledged all 70 events with outputAbandoned=false before the fixture-owned Node was stopped. Public Node status was offline before any Owner action. A then independently read the retained private archive (84 bytes, SHA-256 19a40d5aace0bbecba6ae93da44a06400d00bf0452c453e56e23326d03698c6d), called the authenticated public loom.verification.record and loom.review.record operations, and obtained VERIFIED/PENDING -> VERIFIED/ACCEPTED and task IN_REVIEW -> DONE. Both command replays returned the original records; exactly one verification and one review persisted. The archive still matched after all fixture processes were cleaned up.

Actual command exit 0, elapsed 251.683 s; five fixture source hashes unchanged. Raw evidence: _artifacts/e/accept-1105-054227-1cc8c/result.json. Supervisor summary: _artifacts/r1-core-audit-20261104/artifact-native-fixture-review/acceptance-e1-summary.json. Two HTTP connection-reset traces from provider keepalive teardown are retained; they did not replace or obscure the successful native responses and terminal-state evidence.

Scope is isolated Windows application Owner verification and acceptance, not user acceptance of the whole project or deployed cloud/Linux validation. Binaries remain the separately identified Core11 Host/helper plus EOF-fixed Node. Core12 combined extended-test compile, Mission/claim/archive owner, five effective-readiness owners and subsequent Host/helper build is running against a 391-source frozen snapshot; no PASS is claimed for that running gate.


## Progress 19 — Core12 owner results and actual Codex active-input defect

Core12 extended test compilation passed (400.781 s), and the full Mission claim/artifact owner passed 1/1 (47.485 s, no ignored tests). This closes the earlier owner fixture failures while preserving every original failed log. The 391-source snapshot was unchanged. The following new effective-readiness owner group returned 2 PASS / 3 FAIL because its hand-written permission_mode=default was not a valid shipped configuration. Four replaced only that cfg(test) selection with actual member_runtime_defaults(ClaudeCodeCli), preserved the production prefix and original LF, and froze helper SHA 57cc8452eb33509156387edd1fdd79136983806654c175565e82ba7fee3cbd83. Those five tests still require execution; Core12 is therefore FAIL and did not build new Host/helper binaries.

Evidence: _artifacts/r1-core-audit-20261104/core-integration-probe-12/results.json and _artifacts/effective-readiness/owner-fixture-fix.json. Test binary SHA: 71e42364985cdd43f2ec55c45135ed07bc762dc729cf1df98d032e5510daaea0.

Root's actual Codex E4 reached cold launch, WS reconnect and warm reuse, then its steer was accepted by the public API but failed preparation with mission.workspace_not_prepared. Exact source chain is application/steer.rs -> ContextService.materialize_message_delivery -> DynamicInputContext::prepare -> prepare_workspace_fact. The real remote branch exists and Run target matches; the failing condition instead expects A's starting_git_observation_json, intentionally absent for a B path. Proposed repair is staged, not applied, in _artifacts/r1-core-audit-20261104/context-steer-workspace-fix/proposed.patch: reuse the actual Run's immutable claimed workspace value/digest after revalidating frozen target, current Run/epoch and ready workspace authority. No A Git/filesystem lookup and no next-Run member selection is used. Local and private-chat behavior remain in their original branches. Root is reviewing before the next unified build/gate.


## Progress 20 — remote active-input workspace repair applied; Core13 running

Root reviewed the concrete patch and identified three corrections before source apply: clear both node_id and selection_json in the next-selection fixture to satisfy the paired CHECK; apply frozen-workspace lookup only outside preflight; create an actual distinct remote Node for the wrong-host negative before changing the workspace owner. All three are now in the applied two-file patch. Initial admission preflight and the original local observation branch remain unchanged. No A-side Git or filesystem probe was added.

The runtime repair revalidates the existing Run's frozen target, catalog, prepared workspace generation/token and membership. It then checks current execution epoch, active status, no cancellation and matching member/session/camp/root, and uses only the immutable claimed workspace value plus canonical digest. The existing Mission owner now checks the exact E4 null-A-Git case, malformed/missing/digest-corrupt facts, wrong member/session/epoch/root, next-Run selection changes, ready revocation, changed generation and a wrong host despite the ready A-local row at the same path. This is source/test implementation evidence, not yet a PASS.

Applied evidence: _artifacts/r1-core-audit-20261104/context-steer-workspace-fix/applied-v2.json and proposed-v2.patch. Both edited files passed rustfmt parsing; original LF was preserved without broad formatting. Source hashes: context.rs f56970e95a0abb0d5f5110df5707379d73e41697c47db6719bb87e5b753bdd28; delivery_queue.rs 83b78efeb572646d613f4e15b5edc382c56b41a96a079a34df590fe0276e289d.

Core13 session session-0134d50ec2fbab4c21dada45 is running on the frozen 391-source snapshot. It builds Host/helper first and fixes core13_node_home1 with an immutable build-only/PENDING manifest, then compiles extended tests and runs only the affected Mission owner plus the five effective-readiness owners. The forthcoming binaries can be used for isolated native verification; total acceptance remains separate. Root/peers must keep production files frozen until the final before/after source comparison completes.


## Progress 21 — Core13 fixed product build; owner phase replanned

Core13 Host/helper product build completed with exit 0 in 272.813 seconds. All 391 source hashes remained unchanged. The immutable component manifest is `_artifacts/windows-e2e/bin/core13_node_home1/manifest.json` (SHA-256 `569f6af5915d92a8e431759757b67b5c60950c5447648c15d3a50253b344cd3f`); it records build-only PASS, `ownerGateAtBuild=PENDING`, and `releaseAcceptance=NOT_ACCEPTED`. Host SHA-256 is `286376cd9926f16ce3da2835e6a9f2f30805c00681a5a681ae7a81825db2b23d`; helper is `ef1b9e967b10c5da82a46975431909e23805d1bd51750aff846b541108ca6050`; the reused Node with its B-local CODEX_HOME fix is `6b3a165ba5750e0afe1a92f92068fd418da81751b8ccd78b55615247698e92eb`. The helper reports contract v45 / IPC v3.

At Root's request, the subsequent extended-test compilation was stopped via its exact AgentDock command session after the fixed binaries were available. The four recorded owned process identities were independently checked absent afterward. No other command session was stopped. The original partial compile log, pre-replan result, exact stop receipt, and source snapshots remain under `_artifacts/r1-core-audit-20261104/core-integration-probe-13`. Overall result is `PARTIAL_REPLAN`, not an owner PASS or test failure; Mission/context and readiness owners have not run on this snapshot.

The reason for consolidation is a separately reproduced native Codex MCP stdio serializer defect: JSON null cwd fails while an omitted cwd works. Root owns that narrow fix after this freeze releases. Core14 must run the affected serializer, Mission/context and five readiness owners against the next frozen source; native control and UI probes may use the immutable Core13 binaries with their explicit build-only scope.


## Progress 22 — Core14 fixed product and L-C03 native fixture prepared

Core14 Host/helper build completed with exit 0 in 104.641 seconds, with all 391 source hashes stable. The fixed component manifest is `_artifacts/windows-e2e/bin/core14_node_home1/manifest.json`, SHA-256 `e6fe7ea07ff25a0aed6cda7bf74f6c94c7f0d91f27befe675c37566a741d54a1`. It includes Root's native Codex stdio None-cwd omission fix, the reviewed remote active-input frozen workspace repair, and the effective readiness change. Host SHA-256 is `f13ce4010bcfd5a9fb903d667730adba210c44f807438c2b365d506c88194f87`; helper is `8cbd221b01aca6c3d70bf1b110aadd2583ec781b08ce5a4db74720a0c4e08ee2`. The Node is the unchanged home1 component. This is component build PASS; extended compilation and the seven named Mission/readiness/MCP owner tests are still pending. The fixed manifest remains immutable.

Two new isolated L-C03 fixture files are ready for supervisor review: `_artifacts/windows-e2e/multiagent_e2e.py` and `multiagent_router.py`. They use one Mission, one Node and two real managed members, with independent native process/Run evidence, a held-claim refusal, an artifact-accepted dependency, a queued second worker Run proving the single occupied conversation lane, and three archive-backed submissions followed by separate Owner verification/review. There are no SQL business writes. The router reads only the original request system member identity, matches the actual frozen claim context and live Node owner uniquely, and forwards the original request bytes to the unchanged per-member provider. Shared history markers do not choose a member.

AST parsing and six fixture-only routing sanity cases passed; these use local fabricated Python inputs and are not native host evidence. The report is `_artifacts/r1-core-audit-20261104/lc03-fixture-review/routing-sanity.json`. Native L-C03 has NOT_RUN pending Root's concrete fixture review. This scope does not claim arbitrary native subagent scheduling or test the configured 32-process/200-resident-host capacity thresholds.


## Progress 23 — Core14 six unaffected owners and native L-C03 complete

The exact Core14 compiled test executable (SHA-256 `9d325d792cdbcaa631161e9cde5c41bfc5540a907ed4d5c2e3ea5a30153d01e2`) passed all five effective-readiness owners and the existing Codex MCP session-configuration owner, with exit 0, no ignored tests and all 391 source hashes unchanged. Evidence: `core-integration-probe-14/remaining-fixed-binary/results.json`. The preceding Mission owner remains a recorded FAIL because its new negative fixture used `state='failed'`, which violates the real workspace CHECK before context validation. Root independently reviewed the one-literal cfg(test) correction to valid `preparing`, the complete helper SQL audit and four admitted/rolled-back SQL mutations on an in-memory copy of a prior isolated fixture DB. The approved correction is applied (context.rs SHA-256 `b978ca72922b89fd7204fa3236546f9e2af7e6d9b652dd421bdb9b8506c1923d`), with production prefix/suffix unchanged and rustfmt parse exit 0. Core15 is recompiling only the test executable and rerunning that Mission owner; the six passed owners and fixed product are not being rebuilt/repeated.

Native L-C03 passed on its first actual Windows run in 147.373 seconds, using the immutable Core14 Host/helper and home1 Node. Raw evidence is `_artifacts/e/multi-1105-061933-8009e/result.json`; supervisor re-read is `lc03-fixture-review/native-e1-summary.json`. The actual A authority contains one Mission, one prepared B workspace, two members and three successful Runs. Two distinct live native Claude PID/creation identities overlapped for the first member Runs. Worker competition for the upstream task returned `loom.claim_held`; the downstream task returned `loom.dependency_unreleased` before upstream artifact acceptance. Both refusals preserved the task/claim rows exactly. A queued second worker message remained unclaimed/waiting while its first Run was active, then settled against exactly one new Run in the same conversation.

All three actual claims retain the matching Run/member/Node/epoch and post-binding task revision 3 with fence 1. All three native-produced files were read through the real R2 path, independently hashed and archived by A, submitted, independently verified and accepted through authenticated public Owner actions. Final candidates are VERIFIED/ACCEPTED and all three Tasks are DONE. Supervisor re-read found each real private archive to contain the expected 68 bytes with matching SHA-256 and exactly one verification/review record per candidate. The three native Release acknowledgements consumed their final output sequences 82, 64 and 46 with outputAbandoned=false.

All eight fixture source hashes remained unchanged; the identity router recorded 18 successful unchanged-body model requests across the three actual Run owners, with no rejected/ambiguous routes. It used frozen system identity and the actual Node owner, never shared history markers. Only fixture-owned Host/Node processes were cleaned up after native termination. This proves A-managed members, task DAG ownership, claim exclusivity and conversation lane 1 on the tested Windows pair. It does not assert arbitrary native subagent scheduling, the 32-process or 200-resident-host capacity thresholds, deployed-cloud behavior, or the user's overall project acceptance.


## Progress 24 — Final narrow Mission owner passes; Core freeze released

Core15 completed with exit 0. The extended test executable compiled successfully in 67.453 seconds, and the existing Mission/claim/artifact/remote-workspace owner passed 1/1 in 35.813 seconds with zero ignored tests. All 391 source hashes remained unchanged. Evidence: `_artifacts/r1-core-audit-20261104/core-integration-probe-15/results.json`. The only change from Core14 is the approved cfg(test) literal `failed` to `preparing`; the production context prefix and suffix are byte-identical. The test now reaches the intended Rust authority rejection after each valid SQL mutation, including wrong host with an A-local same-path shadow, generation drift, and retained fact use after next-Run selection changes.

The actual passing owner evidence is deliberately recorded in two rounds: five effective-readiness and one Codex MCP configuration owner passed on the original Core14 test executable; the final Mission owner passed on Core15 after its test-only correction. The original Core14 Mission FAIL is retained. No product rebuild was needed, and the Core14 component manifest and three binary hashes were left untouched. Root, Loom and Four were notified that production source/Cargo freeze is released. This supervisor has no live owned native fixture or test command after these completed gates.
