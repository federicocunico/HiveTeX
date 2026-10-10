# Spec Delta

## MODIFIED Requirements

### Requirement: Presence
Connected members SHALL see who else is online in the project and each editor's cursor/selection in the file they view.
Each member SHALL have one color, derived from their account so it stays the same across projects and devices. That
color SHALL mark their avatar, cursor, selection and the files they have open. Members SHALL see which file each
online co-author is in.

#### Scenario: Cursor display
- **WHEN** a co-author moves their cursor in `main.tex`
- **THEN** other members viewing `main.tex` see the cursor labeled with that co-author's username

#### Scenario: Same color everywhere
- **WHEN** Ada is online in two projects that Federico also has open on two devices
- **THEN** Ada's avatar, cursor and selection have the same color in both projects and on both devices

#### Scenario: Where co-authors are
- **WHEN** Ada has `intro.tex` open
- **THEN** her avatar's tooltip says "intro.tex", and `intro.tex` in the file tree shows a dot in her color

## ADDED Requirements

### Requirement: Follow a collaborator
A member SHALL be able to follow an online co-author from their avatar. While following, the member's editor SHALL
open the co-author's file and keep their cursor in view. Following SHALL stop when the member types, scrolls or picks
another file, or when the co-author goes offline. The followed avatar SHALL be visibly marked.

#### Scenario: Follow and stop
- **WHEN** Federico chooses "Follow" on Kenji's avatar, Kenji moves from `main.tex` to `method.tex`, and Federico then
  scrolls
- **THEN** Federico's editor switches to `method.tex` and tracks Kenji's cursor until the scroll, after which
  following stops and the mark disappears

### Requirement: Distinguishable presence colors
Presence colors SHALL have at least 3:1 contrast against the editor background in both themes. A cursor label SHALL
always show the username, so color is never the only way to identify a person.

#### Scenario: Color is not the only cue
- **WHEN** two co-authors with similar colors are in the same file
- **THEN** each cursor shows its username label
