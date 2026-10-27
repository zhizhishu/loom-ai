# Execution and conversation controls — visual evidence

Captured from production React components on 2026-09-15 with fixed in-memory review data,
isolated Chromium and no Core, Runtime or daily profile. These are UI verification screenshots.

| Surface | Screenshot |
| --- | --- |
| Expanded active tool group in the bottom console, Day | [Execution](execution-day.png) |
| Expanded active tool group in mobile execution, Night | [Mobile execution](execution-mobile-night.png) |
| Conversation rename save action, Day | [Rename](rename-day.png) |
| New-conversation teammate selection, Day | [Teammates](teammates-day.png) |

`pnpm test:execution-avatar-rail` verifies all three execution placements in both themes,
including connecting → thinking → first narration geometry and native disclosure interactions.
See the [transition fixture](../../../scripts/fixtures/execution-state-transition/README.md).
The rename and selection screenshots use the existing `scripts/fixtures/host-web-parity` renderer.

The color audit found generic blue styling on conversation/project rename actions, new-conversation
teammate selection, default-team selection and member invitation checkboxes. These now use the
paired neutral conversation action tokens. Inspected history does not establish a recent global
black-to-blue regression; blue semantic indicators, resource links and Runtime picker styling
remain governed by their existing surface rules.
