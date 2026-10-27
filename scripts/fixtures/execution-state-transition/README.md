# Execution state transitions

`pnpm test:execution-avatar-rail` includes the browser geometry regression in
`scripts/lib/execution-state-transition.test.mjs`. It mounts production `CampWorkspace`
with fixed, in-memory Camp data; no Core, Runtime or daily profile is used.

The test covers connecting → thinking → first one-line narration in the bottom console,
desktop popover and mobile execution tab, in Day and Night. Card position/height and the
first text origin must stay stable. This is distinct from the avatar-rail suite's native
dismissal, navigation and scrolling checks. It also verifies the expanded tool-group cue
without hover/focus and preserves independent child disclosure and keyboard toggling.

Set `ROVAI_TEST_CHROME` to select Chrome. Missing Chrome is reported as a skip, never a pass.
Set `ROVAI_KEEP_EXECUTION_TRANSITION_FIXTURE=1` to retain the isolated fixture, screenshots
and measured rectangles. Failures always retain those artifacts.
