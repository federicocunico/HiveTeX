# public-site Specification

## Purpose
Explains HiveTeX to signed-out web visitors and leads them to create an account, sign in, download the desktop app or
read the source, without slowing down signed-in users.

## Requirements

### Requirement: Landing page for signed-out web visitors
The web app SHALL show a landing page to visitors who are not signed in and open the root address. Signed-in users
opening the root address SHALL go straight to their projects. Links to a specific screen, such as sign-in, a password
reset or a project, SHALL keep working as before.

#### Scenario: First visit
- **WHEN** a visitor without a session opens the root address of the web app
- **THEN** the landing page is shown, not the sign-in form

#### Scenario: Returning user
- **WHEN** a signed-in user opens the root address
- **THEN** the "Your projects" screen is shown and the landing page is not loaded

#### Scenario: Deep link while signed out
- **WHEN** a visitor without a session opens a link to a project
- **THEN** the sign-in screen is shown, and after signing in the user lands in that project

### Requirement: Landing page content
The landing page SHALL explain, in plain language and without protocol jargon, these points:
- live co-writing;
- offline editing with automatic merging;
- compilation by the best available co-author device;
- sources staying on authors' devices;
- GitHub backup;
- import.

It SHALL show a preview of the editor next to the PDF, and SHALL say who the product suits: people new to LaTeX and
experienced users.

#### Scenario: Key messages present
- **WHEN** the landing page is rendered
- **THEN** it contains a headline, a product preview with source and PDF, a feature section covering the six points
  above, and a three-step "how it works" sequence

### Requirement: Landing page actions
The landing page SHALL offer:
- "Create free account" as its single primary action;
- "Sign in";
- desktop downloads for Windows, macOS and Linux, linked to the latest release;
- a link to the source code.

#### Scenario: Start registration
- **WHEN** a visitor activates "Create free account"
- **THEN** the registration screen opens

#### Scenario: Download
- **WHEN** a visitor activates the Windows download
- **THEN** the browser navigates to the latest release's Windows installer, or to the releases page if it cannot be
  determined

### Requirement: Desktop app skips the landing page
The desktop app SHALL NOT show the landing page. Without a session, it SHALL open the sign-in screen.

#### Scenario: Desktop first start
- **WHEN** a user starts the desktop app without a session
- **THEN** the sign-in screen is shown, together with the server it will use

### Requirement: Landing page does not slow down the app
The landing page code and its fonts SHALL load only when the landing page is shown. The JavaScript needed for the
first paint of the signed-in app SHALL stay within the existing initial-load budget.

#### Scenario: Bundle check
- **WHEN** the web app is built and the bundle check runs
- **THEN** the landing page chunk is not part of the initial load and the initial JavaScript stays within budget

### Requirement: Landing page is accessible and responsive
The landing page SHALL meet the same accessibility rules as the rest of the app and SHALL be readable from 360 px wide
upward without horizontal scrolling.

#### Scenario: Phone width
- **WHEN** the landing page is shown at 390 px wide
- **THEN** sections stack in one column, nothing scrolls horizontally, and the automated accessibility check reports
  no serious or critical violations
