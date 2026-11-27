# Access to client systems

A project lists the GitHub repositories and Slack channels its experts need.
ExpertOps grants them to everyone staffed on the project and revokes them when
the person stops being staffed. Revoking is the part that matters: an expert who
has left a project should not still be able to read the client's code.

## The rule

An expert has access to a project's resources **exactly while all of these are
true**:

- They hold a `CONFIRMED` seat on the project.
- The project is not `CLOSED` or `CANCELLED`.
- They are `VERIFIED`.

When any of these stops being true, access is revoked:

| What happened | Recorded reason |
| --- | --- |
| The seat was released (by an operator, or the expert withdrew) | Seat released |
| The engagement was marked complete | Engagement completed |
| The project was closed or cancelled | Project closed / cancelled |
| The expert was archived, rejected or otherwise unverified | Expert is … |
| The resource was removed from the project | Resource removed from the project |

## How it is enforced: reconciliation

`access.reconcile` runs **every 60 seconds**, and straight after a seat is
confirmed, released or completed. Each run:

1. **Works out who should have what**: every confirmed seat on an open project
   with a verified expert, times every resource on that project.
2. **Plans.** It creates missing grants as `PENDING`. It moves grants nobody
   should have any more to `REVOKING`, or straight to `REVOKED` when nothing was
   ever granted.
3. **Executes** up to 10 pending calls, revokes first. Each row is locked with
   `FOR UPDATE SKIP LOCKED` for the duration of its call.
4. **Notices accepted GitHub invitations**, re-checking each one at most every
   6 hours.

It is level-triggered rather than event-driven. It compares the desired state
with the recorded one on every run, so:

- a missed event delays a change by up to a minute, and never loses it.
- a crash halfway through is finished by the next run.
- running it twice does nothing the second time.

### Why a revoke cannot be lost or reordered

- **A grant cannot land after the revoke that should follow it.** The row is
  locked while its provider call runs, so a planner that wants to flip it to
  `REVOKING` waits until the grant has been recorded.
- **A call that succeeded is retried safely.** If the transaction rolls back
  after the provider accepted a call, the row is still `PENDING` or `REVOKING`.
  The next run repeats a call that is idempotent at the provider: adding an
  existing collaborator, inviting someone already in a channel, and removing
  someone already gone all succeed.
- **A revoke always targets the account that was granted.** It uses the GitHub
  login or Slack member id recorded on the grant, never the expert's current
  value. Changing a username therefore revokes the old login and grants the new
  one.
- **Removing a token cannot mark access revoked.** If a grant was made live and
  the token has since been removed, the revoke is refused with
  `REVOKE_FAILED`, not quietly "simulated".

## States

```
PENDING ──► ACTIVE ──► REVOKING ──► REVOKED
   │                      │
   ▼                      ▼
GRANT_FAILED         REVOKE_FAILED   (HIGH attention: they may still have access)
```

- **Retries.** A retryable error (5xx, 429, network) is retried on later runs,
  up to 5 attempts. A permanent error (bad token, missing repository, a
  single-channel guest) fails straight away with the reason.
- **`GRANT_FAILED`** raises a MEDIUM attention item. Fix the cause (usually a
  missing GitHub username), then **Retry**.
- **`REVOKE_FAILED`** raises a HIGH attention item. Either fix the cause and
  **Retry**, or remove the access by hand and **Confirm removed by hand** with a
  note saying what you did. The note is the evidence.

## Setup

### GitHub

1. Create a fine-grained personal access token, or a GitHub App, with
   **Administration: Read and write** on the client's repositories.
2. Set `GITHUB_ADMIN_TOKEN=github_pat_…`.
3. Experts add their GitHub username in their portal. Operators can also set it
   on the expert's page.

Behaviour:

- **Grant:** `PUT /repos/{owner}/{repo}/collaborators/{user}` with the
  resource's permission (`pull`, `triage`, `push` or `maintain`). A new
  collaborator gets an invitation, shown as *Invited* until they accept.
- **Revoke:**
  1. Cancels a still-pending invitation.
  2. Removes the collaborator.
  3. Checks they can no longer reach the repository.
- **Access they keep another way:** if the person can still reach the repository
  through an organisation base permission or a team, the revoke **fails** and
  says so. Reporting "revoked" there would be false.

### Slack

1. Create a Slack app with a bot token. It needs the scopes `channels:manage`,
   `groups:write` and `users:read.email`.
2. Invite the bot to every channel it should manage.
3. Set `SLACK_BOT_TOKEN=xoxb-…`.
4. Add each channel by its id, which starts with C (channel name → About).

Behaviour:

- **Finding the person:** by email (`users.lookupByEmail`). Their member id is
  saved, so a later email change cannot point a revoke at someone else.
- **Grant:** `conversations.invite`. **Revoke:** `conversations.kick`.
- **Someone not in the workspace:** this fails with a clear reason. Inviting
  external people into a workspace (Slack Connect, guest accounts) needs a
  workspace admin, and this build does not do it.

**Without a token**, each system is simulated. Grants are recorded with
provider `simulated` and labelled so everywhere. When a token is added later,
simulated grants are re-granted for real on the next run.

## API

| Method | Path | Capability |
| --- | --- | --- |
| `GET` | `/api/projects/:id/access` | `access:read` |
| `POST` | `/api/projects/:id/access` with `action`: `add`, `remove`, `retry`, `confirm_manual_revoke` | `access:manage` |
| `GET` / `PUT` | `/api/experts/:id/access` (`PUT` sets `githubUsername`) | `access:read` / `access:manage` |
| `GET` / `PUT` | `/api/portal/github` | the expert themselves |

Grant and resource ids are checked against the project in the path.

## The offboarding checklist

The "client system access removed" item still needs a person to confirm it.
ExpertOps revokes what it granted, but a client has other systems (VPNs, cloud
consoles, shared drives) it cannot see. The item's text now says to check that
the managed resources show *Revoked*, then confirm.

## Not done yet

- Other systems: Google Workspace groups, Linear, Jira, cloud IAM. Each one is
  another `AccessProvider`.
- Inviting guests into Slack, and Slack Connect channels.
- SCIM, or SSO-group-based provisioning, for clients who manage access through
  their identity provider.
- Time-boxed access: expiring access at the assignment's end date without anyone
  marking it complete.

## Files

| Area | Code |
| --- | --- |
| Providers (GitHub, Slack, simulated) | `src/server/integrations/access-providers.ts` |
| Reconciliation, resources, identity, retries | `src/server/services/access.ts` |
| API | `src/app/api/projects/[projectId]/access`, `src/app/api/experts/[expertId]/access`, `src/app/api/portal/github` |
| Tests | `tests/unit/access-providers.test.ts`, `tests/integration/access.test.ts` |
