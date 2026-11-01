# tinyai Side Panel UI Contract

This document is the source of truth for Side Panel Settings composition. It is
linked from the requirement and architecture templates; project-specific UI rules
are intentionally not copied into `AGENTS.md`.

## Design language

- Backgrounds use the existing `--bg`, `--surface`, `--surface-2`, `--line`,
  `--fg` and `--muted` tokens.
- Settings content uses a compact grouped-card hierarchy.
- Section labels are muted, small and placed outside the card.
- Setting rows are approximately 48px high, use 14px labels and keep state text
  at 12px.
- Clickable rows have transparent backgrounds, no native border and a subtle
  `--surface-2` hover.
- Complex configuration moves to a dedicated subpage and reuses the existing
  settings form anatomy.

## Settings anatomy

```text
Settings subpage
├── header: back action + title
└── scrollable body
    └── group label
        └── card
            ├── setting row
            ├── separator
            ├── setting row
            └── hidden or inline control
```

## Canonical components

All Settings markup is composed through
`src/sidepanel/settings-components.ts`:

| Primitive | Purpose |
|---|---|
| `settingsSubpage` | Page frame, header, back action and body |
| `settingsGroup` | Label plus one grouped card |
| `settingsCard` | Shared rounded card surface |
| `settingsRow` | Static or custom-control row |
| `settingsNavRow` | Clickable navigation or command row |
| `settingsSelectRow` | Label plus a value/select control |
| `settingsField` | Label plus one form control |
| `settingsForm` | Existing `wb-form` shell |
| `settingsSeparator` | Standard row divider |

The library owns escaping for labels, values and icon wrappers. Callers pass
only trusted control markup constructed from existing application components.

## Navigation

- The Settings home page contains compact entry rows.
- Multi-field configuration opens a subpage.
- A subpage back action returns to Settings.
- Settings then returns to the conversation.
- Model Connections and Chat History follow the same rule.

## Form controls

- Labels sit above controls.
- Text, password, URL and number inputs use 9px radius, `--line` border,
  `--bg` background and the shared focus treatment.
- Primary actions use `wb-btn--primary`; secondary actions use `wb-ghost-btn`.
- Destructive language and color are limited to destructive actions.

## Responsive requirements

- `420x900`: no horizontal overflow; controls span the card width.
- `320x700`: no horizontal overflow; labels may wrap but controls do not clip.
- The page header remains fixed while the settings body scrolls.

## Prohibited patterns

- Raw `wb-set-card`, `wb-set-group` or `wb-set-row` markup in
  `kernel-panel.ts`.
- Browser-default bordered buttons used as settings navigation.
- A second visual card system inside the Settings body.
- Inline multi-field configuration occupying the Settings home page.
- Unstyled `type=url` or `type=number` controls.
- A subpage that closes directly to the conversation.

## Evidence required for UI changes

- Unit coverage for new primitives.
- `npm run check:ui` static contract check.
- Real Chrome E2E for navigation and computed styles.
- Screenshot review at 420x900 and 320x700.
- Requirement `UI impact` map listing reused and new primitives.
