# LOOM Host + Web container — candidate

A Linux x64 container for the **standalone Rovai Server**: the native
`rovai-server` Host plus its matching WebUI and bundled Skill library.

This is a **candidate (`--debug`) build, not a release**, and it is deliberately
narrow. Read the non-claims before relying on it.

## What is in the image

| Path | Content |
| --- | --- |
| `/opt/rovai/rovai-server` | Native standalone Server entrypoint (root-owned, read-only) |
| `/opt/rovai/rovai-host`, `/opt/rovai/rovai` | Compatibility binary and the `rovai` Agent CLI |
| `/opt/rovai/web-ui/` | Matching WebUI build (the Server requires it beside the binary) |
| `/opt/rovai/skills/` | Bundled Skill resources (`cli-operations/SKILL.md` is required at startup) |
| `/opt/rovai/manifest.json`, `linux-abi.json` | Package provenance and the recorded GLIBC ≤ 2.35 ABI report |
| `/data` | Data root, pre-owned by uid 10001 (mount a volume here) |

Runtime identity: **uid/gid 10001**, `HOME=/home/loom`, `STOPSIGNAL SIGTERM`,
port **8767**, `HEALTHCHECK` on the public `GET /`.

## Non-claims (do not overstate)

- **The Pi runtime is NOT bundled.** `scripts/build-server.mjs` packages no Pi
  assets, so this image cannot start a Pi agent. Enable and claim Pi only after a
  separately built and separately verified Pi bundle exists.
- **No agent Runtime is installed.** Core never installs Claude Code, Codex or
  any other Runtime; with none present the assistant list stays “not detected”.
- **No automatic authentication.** There is no default token, no token accepted
  from the environment, and no seeded Owner session. The entrypoint refuses
  `ROVAI_TOKEN`, `ROVAI_SERVER_TOKEN`, `ROVAI_WEB_TOKEN` and `ADMIN_TOKEN`.
- **Not a release channel.** No `latest` tag, no draft GitHub Release, no channel
  pointer promotion, no upgrade path from `scripts/server-release-tag.txt`.
- **Single Owner, trusted self-hosted Host.** No same-UID isolation claim.
- Feishu/DingTalk channels are Desktop-only; they do not exist on the standalone
  Server.

## Build

The image is built by `.github/workflows/loom-v2-container.yml` only, from a
fixed commit, on an `ubuntu-22.04` runner:

1. `actions/checkout` at `github.sha`, then pinned Rust 1.97.1, Node 24.14.1,
   pnpm 11.20.0.
2. `node scripts/build-server.mjs --target-key linux-x64 --debug` — the same
   packaging entrypoint as the release workflow, in its debug profile. Its
   `manifest.json` must record `dirty=false` for that exact commit, and its ABI
   gate rejects GLIBC > 2.35.
3. The allowlisted package plus `docker/Dockerfile`, `docker/entrypoint.sh` and
   `scripts/smoke-linux-server.py` are staged into a temporary directory. The
   Docker context contains **no source checkout, no `.git` and no credential**.
4. `--target verify` runs `scripts/smoke-linux-server.py --expected-profile debug` inside the image as
   uid 10001; `--target runtime` is the artifact.
5. `ubuntu:22.04` is pulled and its digest resolved; the build uses
   `--build-arg BASE_IMAGE=ubuntu@sha256:…` and records that digest.

Trigger: `workflow_dispatch` (publishes only when `publish` is true) or a push to
`rovai/loom-v2-personal-20261116` that touches `docker/**`, the workflow file or
the contract test. Never on `main`, pull requests, schedules or releases.

Tag: `ghcr.io/<owner>/<repo>-server-candidate:sha-<full 40-hex commit>`.
Tags are immutable — a pre-push `docker manifest inspect` refuses to reuse an
existing tag. No `latest`.

## Run

Publish only to host loopback; the Server speaks plain HTTP on 8767 unless you
put TLS or a private network (Tailscale, VPN) in front of it:

```sh
docker volume create loom-data
docker run -d --name loom \
  -p 127.0.0.1:8767:8767 \
  -v loom-data:/data \
  ghcr.io/<owner>/<repo>-server-candidate:sha-<commit>
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/   # 200, public index
```

Then open `http://127.0.0.1:8767/` and log in with the Owner token.

### Read the Owner token

The token is created on first start and stored only in
`<DATA_DIR>/web-auth.json`. Container stdio is not a terminal, so the startup
banner never prints it, and the workflow never reads it:

```sh
docker exec loom /opt/rovai/rovai-server --data-dir /data token
```

Treat that stdout as a secret: do not paste it into CI logs, issues, URLs or
chat. It is not rotatable by restart; a change requires the explicit reset path,
not a redeploy.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `/data` | Absolute, existing, writable, non-symlink data root |
| `LISTEN` | `0.0.0.0:8767` | `host:port`; a non-loopback host adds `--allow-insecure-lan` |
| `PUBLIC_ORIGIN` | unset | Exact reverse-proxy origin; must match the address clients use |
| `VERBOSE` | `0` | `1` mirrors diagnostics to the terminal as well as `<DATA_DIR>/logs/server.log` |

The entrypoint accepts no arguments; use `docker exec` for the Server’s own
subcommands (`token`, `paths`, `node-*`).

### Behaviour you can rely on

- `/data` holds `rovai.sqlite`, `mcp.json`, `skills/`, `instances/<key>/runtime-files/`,
  `logs/server.log` and `web-auth.json`. Back up the whole root, not just the
  database, while the Server is stopped.
- A second Host on the same data root refuses to start (`owned_by_active_core`).
- `SIGTERM`/`docker stop` performs the durable shutdown and exits `0`; a killed
  container is not a completed run and the next start recovers from Core.
- **Never run this image as root** (`--user 0`). Opening an existing database as
  root rewrites WAL owner metadata and the next start is refused with
  `IdentityChanged{stage:Revalidation}`.
- Untrusted networks need TLS/VPN and `PUBLIC_ORIGIN`; a mismatched origin is
  rejected as `origin_not_allowed`. Do not enable URI logging on
  `/api/v1/downloads/*`.

## Verification the workflow performs (all of it runs before any push)

Container contract test, package `manifest.json` commit/dirty/profile refusal,
the existing Server entry/lifecycle/Web/install tests, the packaged ABI gate,
`scripts/smoke-linux-server.py` as uid 10001 inside the image (WebUI, auth,
bundled Skills, exclusive data root, durable SIGTERM, restart persistence),
runtime image unprivileged/toolchain-free/Pi-free assertions, and container
acceptance (unauthenticated `GET /` = 200, unauthenticated API = 401,
`docker stop` exit 0). A run is only evidence for the commit it names; nothing
in this document promotes a candidate smoke result to release qualification. The smoke
keeps `release` as its default and records `packageProfile=debug` /
`releaseProfileVerified=false` for this explicitly selected candidate.

Not covered here: any agent Runtime execution, any model call, real-phone
acceptance, and container-specific qualification. The Server-level Gate B
(Runtime × version × OS) remains outstanding, exactly as for the native package.
