---
document_type: ui-theme-template
authority: renderer-theme-process
status: template
last_updated: 2026-10-25
---

# Theme display name

Copy for an explicitly approved palette; set `document_type: ui-theme`, `authority: renderer-theme`,
`status`, stable `theme_id` and `mode`. Register it in the [theme index](README.md).

## Identity and mode

- Stable `ThemeId` / preference value:
- Display name:
- `ResolvedTheme` / `color-scheme`:

## Palette constraints

State only the palette's surface hierarchy and specific color constraints.
Inherit shared color roles, components and interaction from [DESIGN.md](../../../DESIGN.md).

## Complete semantic token assignments

Provide the complete canonical token set, including surfaces, text, structure, action/hover/contrast/ink,
selection, scrollbar, brand, status, eight identities, ten artifact families, code/diff, dialog and overlay tokens.
Keep shared geometry and aliases; do not add component-level colors or theme-specific markup.

## Contrast requirements

Verify text at 4.5:1 and controls/non-text indicators at 3:1 on their actual surfaces.
Check all identity, status and artifact colors. Follow the [accessibility baseline](../qa/accessibility.md),
including its focus policy; do not claim full WCAG AA from color measurements alone.

## Implementation and verification

Link the production Token block, preference mapping and relevant tests.
Run the [shared theme matrix](../qa/theme-matrix.md), including first paint, switching, native controls,
Portal overlays, 200% zoom and reduced motion. Keep implementation evidence in the owning version record.
