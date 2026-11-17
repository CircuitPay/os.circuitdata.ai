# Feature Specification: Organization File Management

**Feature Branch**: `004-organization-file-management`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Add a file management feature per organization. A top-level menu item that lets a user add/remove upload files. The files will be stored in an R2 bucket."

**Builds on**: `specs/001-clerk-tenant-identity` (a tenant is the user's active organization, or a personal tenant) and `specs/003-tenant-branding-blueprint-isolation` (tenant-scoped data must never cross tenants).

## Clarifications

### Session 2026-11-02

- Q: Who should be allowed to remove a file from an organization's file area? → A: The uploader or an organization administrator (B).
- Q: When someone leaves or is removed from an organization, should the files they uploaded stay available to the organization? → A: Yes; files stay with the organization and keep the departed uploader's name (A).
- Q: Which file types should the product refuse to accept? → A: Everything except a short deny-list of executables and active content such as scripts, installers and HTML (A).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload files to my organization's file area (Priority: P1)

A member of an organization opens a new top-level "Files" entry in the main menu. They see their organization's file area, with each file's name, size, type, who added it and when. They choose one or more files from their device (or drag them in), watch progress while they upload, and the files appear in the list when done. Every other member of the same organization sees the same files.

**Why this priority**: Without upload there is no feature. A shared, per-organization file area is the whole value: files that belong to the team rather than to one person's device.

**Independent Test**: As a member of an organization, open Files, upload a file, and confirm it appears in the list with the right name and size. Sign in as a second member of the same organization and confirm the same file is listed.

**Acceptance Scenarios**:

1. **Given** a signed-in member of an organization, **When** they open the Files menu item, **Then** they see their organization's files (or an empty state inviting them to upload).
2. **Given** the Files page, **When** the member selects one or more files and confirms, **Then** each file shows upload progress and then appears in the list.
3. **Given** a file is uploading, **When** the member leaves the page or the network drops before it finishes, **Then** no partial file appears in the list, and the member is told the upload did not complete.
4. **Given** one upload in a batch fails, **When** the others succeed, **Then** the successful files are kept, and the failed file is identified with the reason.
5. **Given** a file that exceeds the size limit, a file that would push the organization over its storage limit, or a file type that is not accepted, **When** the member tries to upload it, **Then** it is refused before or during the upload with a message that says which limit was hit, and nothing is stored.
6. **Given** a file with the same name as an existing file, **When** the member uploads it, **Then** the existing file is not silently overwritten; the member is asked whether to replace it or keep both.

---

### User Story 2 - Remove files I no longer need (Priority: P1)

A member picks a file in the list and removes it. The product asks them to confirm, then the file disappears from the list for every member of the organization, and its storage no longer counts against the organization's limit.

**Why this priority**: The request names adding and removing together. Without removal the area fills up with no way to clean up, and an accidentally uploaded sensitive file could not be taken back.

**Independent Test**: Upload a file, remove it, confirm it no longer appears (including after a reload and for a second member), and confirm it cannot be fetched by its previous address.

**Acceptance Scenarios**:

1. **Given** a file in the list that the member may remove, **When** they choose Remove and confirm, **Then** the file leaves the list and can no longer be downloaded by anyone.
2. **Given** the removal confirmation, **When** the member cancels, **Then** the file is untouched.
3. **Given** a file removed by one member while another member has the page open, **When** the second member's list refreshes or they act on that file, **Then** the file is gone and any action on it fails with a clear "no longer exists" message rather than an error.
4. **Given** a member who is not the file's uploader and not an organization administrator, **When** they try to remove it, **Then** the attempt is refused and the file remains.
5. **Given** several files selected, **When** the member removes them together and confirms, **Then** each one the member is allowed to remove is removed and any that are not are reported.

---

### User Story 3 - Download or open a file (Priority: P2)

A member selects a file and downloads it, or opens it in the browser when the browser can display it. Only members of the organization can do this.

**Why this priority**: A file area that cannot return files is not useful, but the list-and-upload and remove stories already demonstrate the isolation and storage behavior, so this ranks just below them.

**Independent Test**: Upload a file, download it, and confirm the bytes are identical. Try to reach the same file as a member of another organization and as a signed-out visitor and confirm both are refused.

**Acceptance Scenarios**:

1. **Given** a file in the list, **When** a member chooses Download, **Then** they receive the file with its original name and unchanged contents.
2. **Given** a file the browser can display safely (for example an image or PDF), **When** a member chooses Open, **Then** it is displayed; **Given** any other type, **Then** it is downloaded, never executed or rendered as a page.
3. **Given** a member of a different organization, or a visitor who is not signed in, **When** they try to reach a file by any address they may have obtained, **Then** access is refused and nothing about the file is revealed.

---

### User Story 4 - Files follow the active workspace and stay isolated (Priority: P1)

A person who belongs to two organizations, or to an organization and their personal workspace, sees a different file area for each. Switching the active workspace switches the files shown; no file from one workspace is ever visible, downloadable, removable or countable in another.

**Why this priority**: "Per organization" is the defining requirement. A leak between organizations is a trust failure worse than missing functionality.

**Independent Test**: Put different files in two organizations. As a user who belongs to both, switch between them and confirm each shows only its own files. As a user who belongs only to one, confirm the other's files cannot be listed, fetched or removed even if names or addresses are guessed.

**Acceptance Scenarios**:

1. **Given** a user in two organizations, **When** they switch the active organization, **Then** the Files page shows only the newly active organization's files, with nothing from the previous one remaining on screen.
2. **Given** a user in their personal workspace, **When** they open Files, **Then** they see a file area private to that workspace.
3. **Given** a user who has left an organization or been removed from it, **When** they try to list, download, add or remove its files, **Then** every attempt is refused.
4. **Given** two organizations that each upload a file with the same name, **When** each lists its files, **Then** each sees only its own file and neither overwrites the other.
5. **Given** an attempt to list, fetch, add or remove using another organization's identifier, **When** the request is made, **Then** it is refused; the active workspace is decided by the verified sign-in, never by a value the browser supplies.

---

### User Story 5 - See how much storage the organization is using (Priority: P3)

The Files page shows the organization's total storage in use against its limit, and how many files it holds, so members know whether there is room before uploading.

**Why this priority**: It prevents confusing refusals, but the limit is enforced either way.

**Independent Test**: Upload and remove files and confirm the usage figure rises and falls accordingly, and that an upload that would exceed the limit is refused with the usage shown.

**Acceptance Scenarios**:

1. **Given** an organization with files, **When** a member opens Files, **Then** they see total used storage, the limit, and the file count.
2. **Given** a successful upload or removal, **When** the list updates, **Then** the usage figure updates with it.

---

### Edge Cases

- A file name with spaces, accents, emoji, path separators, or very long length: the original name is shown as typed, stored safely, and never lets a file land outside its organization's area or collide with another's.
- A zero-byte file: accepted, or refused with a clear message, but never shown as a broken entry.
- Two members upload the same name at the same moment: neither silently destroys the other's file; the result matches the replace-or-keep-both rule.
- An upload stalls or the browser closes mid-way: no partial file is left visible, and abandoned partial data does not count toward the organization's limit for long.
- A member removes a file while another is mid-download: the download either completes or fails cleanly; the file is gone afterwards.
- A user's membership or role changes while the Files page is open: the next action is evaluated against their current role, not the one they had when the page loaded.
- A file whose contents could be active content (a web page, a script, an SVG): it is only ever served for download or in a way that cannot run in the product's own origin.
- The storage backend is temporarily unavailable: the page shows an understandable error and offers retry; the file list never shows files that are not actually retrievable.
- An organization with thousands of files: the list is paged or searchable and the page stays responsive.
- Deleting an organization or removing its last member: its files are handled by the rule in Assumptions rather than being left reachable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST provide a top-level "Files" entry in the main navigation, available to every signed-in user.
- **FR-002**: Each tenant (an organization, or a user's personal workspace) MUST have its own file area, and the Files page MUST show only the active tenant's files.
- **FR-003**: Members MUST be able to upload one or more files from their device, with visible progress and a clear success or failure result per file.
- **FR-004**: The system MUST NOT list a file until its upload has completed in full, and MUST NOT leave a partial file visible or retrievable after a failed or abandoned upload.
- **FR-005**: The Files list MUST show, for each file, its name, size, type, uploader and upload date, and MUST be ordered predictably (newest first by default) and remain usable with large numbers of files.
- **FR-006**: Members MUST be able to remove a file after an explicit confirmation, and a removed file MUST stop being listed and stop being retrievable immediately.
- **FR-007**: Members MUST be able to download a file with its original name and unchanged contents.
- **FR-008**: The system MUST refuse any list, download, upload or removal request for a tenant other than the caller's verified active tenant, and the tenant MUST be decided by the verified sign-in, never by a client-supplied value.
- **FR-009**: The system MUST evaluate membership and role at the time of each action, so a user removed from an organization immediately loses access to its files.
- **FR-010**: The system MUST enforce a maximum size per file and a maximum total storage per tenant, and MUST report which limit was hit when it refuses an upload.
- **FR-011**: The system MUST refuse file types on a defined deny-list and MUST serve files so that their contents can never execute in the product's own origin.
- **FR-012**: When an upload has the same name as an existing file in the tenant, the system MUST NOT silently overwrite it; the member MUST choose to replace it or keep both.
- **FR-013**: A removal MUST be permitted for the file's uploader and for organization administrators, and refused for everyone else, with a clear message.
- **FR-014**: The Files page MUST show the tenant's storage used, storage limit and file count, and keep them accurate after uploads and removals.
- **FR-015**: Every upload, removal and refused attempt MUST be recorded with who, which tenant, which file and when, without recording file contents, so the actions can be audited.
- **FR-016**: Files MUST be stored in object storage owned by the deployment (the requester specified an R2 bucket; see Assumptions), with each tenant's files kept apart from every other tenant's.
- **FR-017**: The Files page MUST present clear empty, loading, error and retry states and MUST be fully operable by keyboard and screen reader, including upload, selection, removal confirmation and progress announcements.
- **FR-018**: Existing deployments MUST gain the feature without any manual data migration, and a deployment that has not been given a file bucket MUST show Files as unavailable with an explanation, rather than failing.

### Key Entities

- **Tenant**: The owner of a file area: an organization, or a user's personal workspace. Already defined by the tenant identity feature. Each tenant has exactly one file area and one storage limit.
- **File**: A stored upload belonging to one tenant. Has a display name, size, content type, uploader, upload time, and a stable identity that does not change if another file is replaced or removed.
- **Uploader**: The member who added a file. Used for display, for the removal rule, and for the audit trail.
- **Storage Usage**: A tenant's total bytes and file count against its limit. Derived from the tenant's files, so it cannot drift from what is actually stored.
- **Storage Limits**: The per-file maximum and per-tenant total set for the deployment.
- **Audit Record**: A who/what/when entry for each upload, removal and refused attempt, with no file contents.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can open Files and complete a first upload of a typical document (under 10 MB) in under 30 seconds on a normal connection.
- **SC-002**: A member can remove a file, including the confirmation, in under 10 seconds.
- **SC-003**: In isolation testing with at least three tenants, 0 of the attempts to list, download, upload to or remove from another tenant's file area succeed, including attempts using guessed names or identifiers.
- **SC-004**: 100% of failed or abandoned uploads leave no visible file and no change to the tenant's reported storage once the failure is reported.
- **SC-005**: After a removal, the file is unavailable to every member and every address within 5 seconds, and the storage figure reflects it on the next view.
- **SC-006**: A user removed from an organization is refused on their very next Files action.
- **SC-007**: The file list of an organization with 5,000 files is usable (first page shown) in under 3 seconds.
- **SC-008**: At least 90% of first-time users complete an upload and a removal without help.
- **SC-009**: A deployment without file storage configured shows Files as unavailable and every other area of the product continues to work normally.

## Assumptions

- **Sign-in modes**: Files needs a tenant, so it is offered only on deployments that sign users in with organizations (Clerk). A deployment with legacy password, Access or gatekeeper sign-in has one shared account space and no organizations; there the menu item is absent. The unavailable state in FR-018 covers a Clerk deployment whose file storage is not configured.
- **Who can use it**: Every member of an organization can see and add files; no separate permission to enable Files is needed. A user's personal workspace gets its own private file area.
- **Removal rule**: A file may be removed by its uploader or by an organization administrator (clarified). In a personal workspace the owner may remove anything.
- **Limits** (starting defaults, adjustable by the deployment operator): 100 MB per file, 5 GB per tenant. They are enforced on the server, not only in the browser.
- **Accepted types**: Any common document, image, archive, audio or video file is accepted; only a short deny-list of executable and active-content types is refused. Files are never interpreted or previewed beyond safe image and PDF display.
- **Flat area**: Each tenant has one flat list of files; folders are out of scope.
- **Not in scope**: Sharing with people outside the organization, public links, versioning, trash or undo, virus scanning, full-text search of contents, in-product editing, quotas per member, and exposing files to agents or gadgets. Any of these can follow as separate features.
- **Name search**: Filtering the list by name is included in "remains usable with large numbers of files"; sorting beyond newest-first is not required.
- **Organization lifecycle**: When an organization is deleted, its files are deleted too. Removing a member does not remove the files they uploaded: they stay with the organization, keep the former member's name as uploader, and remain removable by organization administrators.
- **Operator-owned storage**: The requester specified an R2 bucket as the storage location; this is a fixed constraint, not an open choice. The bucket is created and bound by the deployment (infrastructure and release configuration), not by end users; a missing bucket is a configuration state the product handles (FR-018).
- **Dependencies**: Reuses the existing sign-in, tenant resolution and organization role information from the tenant identity feature, and the existing main navigation.
