# project-templates Specification

## Purpose
Lets a user start a new project from a ready-made, compiling document instead of an empty file. This gives newcomers a
working example and saves experienced users the boilerplate.

## Requirements

### Requirement: Template gallery in project creation
The "New project" dialog SHALL offer a gallery of bundled templates, each with:
- a name;
- a one-line description of what it contains;
- a preview of its first page.

The gallery SHALL include at least:
- Blank;
- Article;
- Thesis or report;
- Beamer slides;
- Letter;
- CV.

"Blank" SHALL be selected by default, so creating a project without picking a template behaves as today.

#### Scenario: Gallery shown
- **WHEN** a user activates "New project"
- **THEN** the dialog shows the template gallery with "Blank" selected, plus the project name and project ID fields

### Requirement: Templates are available offline
Templates SHALL ship with the app and SHALL NOT require a network request to list, preview or use.

#### Scenario: Offline desktop
- **WHEN** a desktop user without a network connection opens the gallery
- **THEN** all templates and their previews are shown

### Requirement: Project created from a template
Creating a project with a template selected SHALL create the project as today, with the same ID, password and folder
rules. The template's files SHALL be its initial content, and its main file SHALL be marked as the root document.
"Blank" SHALL produce the same empty project that project creation produces today.

#### Scenario: Article template
- **WHEN** a user creates a project from "Article"
- **THEN** the project contains the article's `main.tex`, its bibliography file and any template folders, and
  `main.tex` is the root document

#### Scenario: Template into a folder (desktop)
- **WHEN** a desktop user creates a project from a template and chooses "Store in a folder…"
- **THEN** the template files are written into that folder, following the project-locations rules

### Requirement: Templates compile cleanly
Every bundled template SHALL compile without errors in the in-browser compiler and with a standard TeX distribution,
using only packages those provide.

#### Scenario: Template check
- **WHEN** the template test suite compiles each bundled template
- **THEN** each produces a PDF with no errors

### Requirement: Templates teach by example
Each non-blank template SHALL contain short comments explaining its main parts, such as where the title goes, how to
add a section, how to cite and how to include a figure. It SHALL contain only text and images the project may
redistribute.

#### Scenario: Article guidance
- **WHEN** a user opens `main.tex` of a new Article project
- **THEN** comments next to the title, abstract, first section, a citation and a figure explain what to change
