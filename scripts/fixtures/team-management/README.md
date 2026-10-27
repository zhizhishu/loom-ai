# Team workspace fixture

Run from the repository root after installing dependencies:

```sh
node scripts/fixtures/team-management/serve.mjs
```

Open `http://127.0.0.1:57262/`. The fixture imports production Team workspace,
General settings and New conversation components, with an in-memory Core API.
It neither starts Electron/Core/Runtime nor reads daily application data.

The default library contains teams of 4, 6 and 12 members. Use `?empty` for the
empty state, `?lang=en` for English, and `?theme=night` for the night theme
(`day`, `horizon`, `classic-red` and `ember` are also supported);
query parameters can be combined. Reloading resets all fixture changes.

Review creation, duplication, deletion, unsaved changes, member selection and
lead changes. In General settings, switch between a team and Custom; in New
conversation, verify that team members are read-only and a Custom selection
survives switching away and back. Check keyboard focus, touch actions, a narrow
viewport, long lists, and the position of the save footer.

The fixture's top navigation buttons are test controls. This is component-level
visual and interaction evidence; it does not verify native application chrome,
IPC, persistence, authentication or real Runtime delivery. Core contracts,
database tests and an isolated Runtime probe cover those separate boundaries.

Run the deterministic save/create regression with
`node --test --test-name-pattern='Team creation' scripts/lib/member-creation.test.mjs`.
It mounts the production BusinessApp in isolated Electron and completes save/list
Promises explicitly, covering the saved version, late initial selection and draft
preservation. It uses no Core or Runtime and does not use sleeps to order the race.
The same fixture covers Custom creation with rejected/pending team reads, explicit
recovery from a failed selected Team, retry with a fresh version, and convergence
of unchanged invalidation receipts through the production Host preference wrapper.
It also holds background list reads pending while editing and leaving the Team
workspace, verifies that leave/delete confirmations stay usable, and delivers new
rosters before an old invalidation receipt to check that only the latest observation
is rechecked once. Initial loading and a new draft with an empty library are covered.
