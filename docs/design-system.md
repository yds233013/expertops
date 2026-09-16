# Design system

One palette and one set of components across the operator workspace, the
applicant pages, the expert portal, the public demo and sign-in.

## Tokens

Defined once in `src/app/globals.css` (`@theme`): warm ivory page
(`ink-50`), slate text (`ink-900`), deep teal for anything that can be acted on
(`accent-500`), navy for the rail and the sign-in panel (`navy-900`). Colour is
kept for meaning: amber for "a person needs to act", rose for failures and
destructive actions, green for settled outcomes. Exported payments are
deliberately neutral, never green — nothing in the build means money moved.

Component classes (`.card`, `.btn`, `.input`, `table.data`, …) live in
`@layer components`, so a Tailwind utility written beside one wins.

## Components (`src/components/ui.tsx`)

| Component | Use it for |
| --- | --- |
| `PageHeader` | Every page title. `eyebrow` names the section, `back` links a detail page to its list, `actions` hold the page's primary controls |
| `NextAction` | The one decision a record is waiting on, above everything else |
| `StatTile` | A count with a plain-language `sub` line; `href` when the number stands for a list |
| `Card` (`flush` for tables) | A titled surface |
| `Toolbar`, `ToolbarField` | Search and filters above a table, with visible labels |
| `TableShell`, `CellPrimary` | Tables that scroll inside their card; the row's subject with its reference underneath |
| `CursorPagination` | "Showing 50 of 105", back to the start, next |
| `KeyValue`, `FieldRow` | Record facts that wrap long values and stack on phones |
| `EmptyState` | What an empty list means and what to do about it |
| `ProgressSteps` | Where an applicant is: received, screening, review, decision |
| `SampleDataBadge` | The single "Demo workspace · Sample data" mark |
| `StatusBadge` | One tone per status, across every entity |

Also: `ActivityList` (append-only history, recent first, the rest folded),
`PublicShell` (the frame around every page outside the workspace), the
`.segmented` filter control and the sticky `.section-nav` for long records.

## Screenshots

`scripts/capture-screenshots.ts` photographs every main surface at desktop and
mobile widths against a local copy of a seeded network, signing in as a
throwaway operator and entering the portals through fresh single-use links. It
refuses any database that is not a local scratch copy. Before-and-after pairs
from the 16 September 2026 redesign are in `docs/screenshots/compare/`.
