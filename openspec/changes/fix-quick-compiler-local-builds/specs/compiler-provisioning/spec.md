# Spec Delta

## MODIFIED Requirements

### Requirement: Quick-compiler builds stay on the device
Because the quick compiler cannot prove which files a document read, builds made with it SHALL stay on the device that
made them: the device SHALL compile its own copy of the project automatically, SHALL NOT be eligible as the project's
compile leader, and SHALL NOT send its results to others. Shared builds SHALL come only from compilers whose file reads
are verified (a system TeX installation or the app-managed full LaTeX).

#### Scenario: Collaborator tries to read a local file
- **WHEN** a co-author's source contains `input{C:/Users/alice/secret.txt}` and Alice's device compiles with the quick
  compiler
- **THEN** the resulting PDF stays on Alice's device and is never sent to the co-author

#### Scenario: Shared builds still work
- **WHEN** one member has full TeX and another only the quick compiler
- **THEN** the member with full TeX leads and shares PDFs, and the other member sees its own local builds

#### Scenario: Project opened with only the quick compiler
- **WHEN** a desktop user whose only compiler is the quick compiler opens a project and does not edit it
- **THEN** their device compiles the project once it is ready and shows the PDF, without waiting for an edit

#### Scenario: Compile requested with co-authors online
- **WHEN** a user whose only compiler is the quick compiler clicks Compile while co-authors are connected
- **THEN** their device compiles the project and shows its own PDF, and nothing is sent to the co-authors

#### Scenario: Quick compiler installed while the project is open
- **WHEN** the quick compiler finishes installing (automatically or from Account > Compiler) while a project is open
- **THEN** the project is compiled on this device without reopening it

#### Scenario: Status of a quick-compiler device
- **WHEN** a device compiles with the quick compiler and its stored preference is *Automatic*
- **THEN** the status bar says the project compiles only on this device with the quick compiler, and never says that no
  compiler is available
