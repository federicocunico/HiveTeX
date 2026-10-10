# Heuristic walkthrough (task 9.2)

Date: 2026-10-10. Web app, Chromium, light theme at 1024 × 760 and dark theme at 1440 × 760, plus phone width
(390 px) for the landing and registration pages. Screens were captured by a scripted walk and reviewed against the
usability notes in `mockup/hivetex-redesign.html` (Nielsen heuristics H1–H10, two personas).

## Flows

**Newcomer**: land on the site → create an account (rules shown while typing) → empty projects page ("Start your first
paper") → New project with the Article template → write → compile → a `\citep` error explained in plain words with
**Add natbib** → Share (copy the invitation) → the tour from Help.

**Expert**: Ctrl+K palette for actions, files, headings (`@`) and lines (`:`) → Ctrl+Enter / Ctrl+S compile → Ctrl+Shift+E
and Ctrl+Alt+P to reshape the screen → resize panes with the keyboard → focus mode → Vim keys → follow a co-author →
shortcut reference (Ctrl+Shift+/).

## Findings and what was done

| # | Where | Heuristic | Finding | Outcome |
|---|---|---|---|---|
| 1 | Workspace at 1024 px | H3 user control | The side panel kept covering the editor after picking a file. | Fixed: below 1100 px the panel is a temporary overlay; picking a file, a line or a heading, or clicking the editor, closes it. Covered by `workspace.spec.ts`. |
| 2 | Problems | H9 error recovery | Right after typing and compiling, a missing-package error could get the generic explanation, because the help read source text that was up to 0.4 s old. | Fixed: a new compile result refreshes the text index at once. |
| 3 | PDF pane | H1 visibility | A re-render could show "doc?.destroy is not a function" (pdf.js 6 moved `destroy()` to the loading task). | Fixed in `PdfView.svelte`. |
| 4 | PDF bar, landing preview | H8 aesthetics | Status pills ("Up to date", "PDF up to date") wrapped onto two lines in narrow bars. | Fixed: pills never wrap. |
| 5 | Landing preview | H8 aesthetics | Wrapped source lines started under the line numbers. | Fixed: one grid row per source line. |
| 6 | Template gallery | H8 aesthetics | Six templates in rows of five left one orphan. | Fixed: two rows of three (two columns on phones). |
| 7 | Share / members | H5 error prevention | Owners were offered Remove and Ban on their own row. | Fixed: your own row shows your role, without actions. |
| 8 | Workspace header | H6 recognition | Header avatars only appear when co-authors are online; alone, there is no hint that collaboration exists. | Kept: the Share button and the People panel say it; an empty avatar row would be noise. |
| 9 | Projects page | H4 consistency | Rows show no co-author avatars (the mockup had them) because the project list API returns no members. | Open: needs an API field; tracked as a follow-up, not part of this change. |

## Not covered here

- The desktop app (WebView2 / WebKitGTK) was not walked through: its UI test needs `msedgedriver` and the default
  ports, neither available in this environment. The desktop shell builds with the new window limits and icons.
- Screen-reader walkthroughs beyond the automated axe checks.
