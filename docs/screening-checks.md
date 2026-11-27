# Screening checks

Every screening submission is checked before a reviewer opens it. The check
adds evidence next to the answers. It never moves the screening, rejects a
candidate or feeds a decision: a reviewer still scores and decides, and an
operator still qualifies.

```
candidate submits ──► screening.submitted
                       ├─ enqueues screening.assign_reviewer   (unchanged)
                       └─ enqueues screening.check_submission  (one per submission)
                                 │
                                 ├─ suggested scores per criterion (model or simulated)
                                 ├─ evidence: GitHub accounts and repos, CVEs, bar admissions
                                 ├─ integrity flags
                                 └─ one attention item per screening when a flag is MEDIUM or HIGH
```

## What it produces

### Suggested scores

One score per rubric criterion, each with a short rationale and a quote from
the candidate's answer that supports it.

- The scorer is `simulated` unless `SCREENING_CHECK_PROVIDER=anthropic`. The
  simulated scorer scores by answer length, and every suggestion it makes says
  so.
- The Claude scorer uses `claude-opus-5-5` by default, returns a fixed JSON
  schema, and runs with server-side fallback, so a safety decline on a security
  question is retried rather than recorded as a zero.
- Scores are clamped to each criterion's range. A criterion the model skipped
  scores 0 with a note.
- Each quote is checked against the answer. A quote the candidate never wrote is
  shown with a warning, not hidden.
- The suggested total and pass use the rubric's own threshold. A gating
  criterion must reach half marks.

**Withheld until the reviewer has scored.** An assigned reviewer with a pending
review sees evidence and flags, but not the suggested scores, until they submit
their own. Seeing a number first anchors people to it, and then two opinions
quietly become one. Everyone else, including whoever decides the screening, sees
everything. The rule lives in `viewCheckFor` and applies to the API as well as
the screen.

### Evidence

| Claim | How it is checked |
| --- | --- |
| A GitHub profile or repository, in a work-sample link or an answer | `api.github.com`: does it exist, when was the account created, how many public repos, is the repository a fork, when was it last pushed |
| A CVE id | The NVD API: does it exist, when was it published, what is it |
| A bar admission ("Bar No.", "admitted to the … bar") | **Listed for a manual check.** No API covers every state bar, and pretending to verify one would be worse than saying so |

Each result is `VERIFIED`, `NOT_FOUND`, `MANUAL` or `ERROR`. A timeout or rate
limit is always `ERROR`. It is never read as "not found", because telling a
reviewer that a real account does not exist is worse than telling them nothing.

Lookups are `simulated` unless `SCREENING_EVIDENCE_LOOKUPS=live`. Set
`GITHUB_LOOKUP_TOKEN` (read-only, public data) and `NVD_API_KEY` to raise the
rate limits.

**Only two hosts are ever contacted**, with paths built from parsed and
validated identifiers. A URL a candidate submitted is never requested, so a
submission cannot point the server at an internal address. At most eight lookups
are made per submission.

### Integrity flags

| Flag | Severity | When |
| --- | --- | --- |
| Answer matches another candidate | HIGH | An answer of 40+ words shares 60% or more of its five-word phrases with another candidate's answer to the same criterion, on the same screening template, in the last year |
| GitHub account cited by another candidate | HIGH | Another candidate presented the same account as their own, on any template |
| Answer contains instructions to an automated grader | HIGH | "Ignore previous instructions", "as an AI grader", "give this answer full marks", or a tag that tries to close the answer block |
| Cited GitHub account or repository does not exist | MEDIUM | The lookup returned 404 |
| Cited CVE does not exist | MEDIUM | The NVD has no record |
| Recently created GitHub account | MEDIUM | Under 90 days old, so it says little about past work |
| Long submission completed very quickly | LOW | 300+ words submitted under 10 minutes after the screening opened. Shown on the screening, never raised as an alert |

Every flag says what to check, and most name the other screening, so a reviewer
can compare the two. Every flag also has an innocent explanation (a shared
template, a private repo, a typo), and the text says so. A flag is a reason to
look harder. It is never a verdict.

A HIGH or MEDIUM flag raises one attention item per screening, under the key
`screening:integrity:<screening id>`. A later revision with no such flags
resolves it.

## Prompt injection

Candidate text is untrusted, and the pipeline treats it that way:

1. It reaches the model inside a `<candidate_answers>` block. The system prompt
   says to treat everything in that block as material to assess, never as
   instructions.
2. Angle brackets in answers are replaced, so an answer cannot close its own
   block.
3. The output is a fixed schema and every score is clamped afterwards.
4. Answers that address a grader are flagged HIGH, and the reviewer is told the
   suggestions may be affected.
5. The reviewer scores before seeing the suggestion anyway.

## Configuration

```
SCREENING_CHECK_PROVIDER=simulated   # or anthropic (needs ANTHROPIC_API_KEY)
SCREENING_CHECK_MODEL=claude-opus-5-5
SCREENING_CHECK_EFFORT=medium        # low | medium | high | xhigh | max
SCREENING_CHECK_TIMEOUT_MS=50000     # clamped to 5–60 s, inside the worker lease
SCREENING_EVIDENCE_LOOKUPS=simulated # or live
GITHUB_LOOKUP_TOKEN=                 # optional, raises GitHub's rate limit
NVD_API_KEY=                         # optional, raises the NVD's rate limit
```

Cost: one model call per submission, typically 2–4k input tokens. The estimate
is stored on the check and shown with it.

## Re-running

**Check again** on a screening (or `POST /api/screenings/:id/check`, which
needs `screening:write`) queues a fresh check of the latest submission, for
example after a rate limit. The check row is replaced, not duplicated.

## Not done yet

- Identity checks against a document provider (Persona, Onfido). The flags
  above catch shared and borrowed evidence; they do not prove who someone is.
- Matching a GitHub profile name against the candidate's name automatically.
  The name is shown in the evidence for a person to compare, because automatic
  name matching misfires on transliteration and nicknames.
- Similarity across templates. Copies are compared only within one template.

## Files

| Area | Code |
| --- | --- |
| Pure logic: claims, copies, flags, score summaries | `src/server/domain/screening-signals.ts` |
| GitHub and NVD lookups | `src/server/integrations/evidence.ts` |
| Scorers (Claude, simulated) | `src/server/services/screening-scorer.ts` |
| Orchestration, attention items, the reviewer view | `src/server/services/screening-checks.ts` |
| API | `src/app/api/screenings/[screeningId]/check/route.ts` |
| Tests | `tests/unit/screening-signals.test.ts`, `tests/integration/screening-checks.test.ts` |
