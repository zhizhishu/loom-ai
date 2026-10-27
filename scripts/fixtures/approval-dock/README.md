# Approval Dock interaction fixture

The fixture mounts the production `ApprovalDock` and stylesheet with synthetic approvals.
It exercises native mouse/keyboard input, notification focus, decision identity and Reason
overflow under desktop and mobile layout changes. It uses isolated temporary Electron data and never starts Core
or a Runtime. The surrounding controls and execution-console shell are test scaffolding.

Run `pnpm test:approval-dock`. Set `ROVAI_KEEP_APPROVAL_FIXTURE=1` to retain the temporary
screenshots; Linux requires `xvfb-run -a`. Assertions are the regression authority; the
screenshots below are review evidence captured on macOS on 2026-09-15.

Mobile cases load the production Web stylesheet and `MobileLayoutProvider` on the same fixture.
They cover 375/390/430px portrait, 844px landscape, a 500px viewport, 44px approval controls,
complete JSON, neutral command backgrounds, safe focus/decision identity, and user scrolling
to the last of twelve long native options. They emulate
phone geometry in Electron; they do not qualify a real iOS/Android keyboard or network approval.

![Porcelain Day, wide conversation column](screenshots/day-wide.png)

![Steel Night, 1040 by 700 window with a 420px conversation column](screenshots/night-minimum.png)

![Porcelain Day, 375px mobile approval](screenshots/mobile-day.png)

![Steel Night, 390px mobile approval](screenshots/mobile-night.png)

![Landscape approval, content and decisions remain scrollable](screenshots/mobile-landscape.png)
