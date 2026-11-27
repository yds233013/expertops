# Task quality

On an evaluation project an expert does not hand in "a deliverable". They hand
in a **task**: a prompt, a reference answer, and a rule for deciding whether
some other answer is right. A lab pays for tasks that measure something. Three
kinds of task do not, and a reviewer should not have to find them by hand:

| Problem | What it looks like | Why it matters |
| --- | --- | --- |
| **Broken** | The reference answer fails its own checker, or the checker cannot run | Every model "fails" it, and the failure means nothing |
| **Leaking** | The reference answer is written in the prompt | Every model "passes" it, and the pass means nothing |
| **Too easy** | A frontier model solves it every time | It does not separate one model from another |

This page covers the three pieces built to catch them, and to keep the people
who review tasks consistent with each other:

1. **Task checks**: every submitted task is checked automatically before a
   reviewer reads it.
2. **Gold tasks**: reviewers answer tasks whose right decision is already
   known, which gives each reviewer a calibration score.
3. **Expert scorecards**: patterns across one expert's reviewed work, for
   operators to see.

Everything here is **evidence for a person**. A check never approves, rejects or
pays for a submission. A low calibration score never stops anyone reviewing. A
scorecard never feeds matching. The rule in `work.ts` still holds: a review
judges one submission, never a person.

---

## 1. Task checks

### The task format

A submission can carry an optional `taskSpec` (`src/server/domain/task-checks.ts`):

```json
{
  "prompt": "A retailer reports cost of goods sold of $4,860,000 ...",
  "referenceAnswer": "6.00",
  "checker": { "kind": "NUMERIC", "tolerance": 0.005 }
}
```

| Checker | Passes when | Notes |
| --- | --- | --- |
| `EXACT` | The answer equals the reference after trimming, collapsing spaces and dropping a trailing full stop | Case-insensitive unless `caseSensitive: true` |
| `NUMERIC` | `abs(answer - reference) <= tolerance` | Reads `$1,250`, `12.5%`, `-3e2`. Refuses "between 3 and 5" |
| `REGEX` | The whole answer matches the pattern | Anchored, case-insensitive, at most 300 characters |

An expert adds the task in the portal by ticking "This is an evaluation task".
`submitWork` validates it with the same schema and refuses a malformed one with a
400, so a bad task never reaches the check.

### What happens on submit

```
expert submits a task
  └─ submitWork stores taskSpec on the WorkSubmission
     └─ enqueues work.check_task   (dedupe key: one per submission)
        └─ worker: runTaskCheck
           1. re-read the submission; skip if superseded or cancelled
           2. structural checks (no model needed)
           3. if nothing blocks: N model attempts, in parallel
           4. decideVerdict → one TaskCheck row (unique per submission)
           5. activity event; attention item for BROKEN / LEAK / TOO EASY,
              or resolve the previous one if a revision fixed it
```

**Structural checks** run first and cost nothing:

- `REFERENCE_FAILS_CHECKER` (blocks): the key does not pass its own checker.
- `CHECKER_UNUSABLE` (blocks): for example a `NUMERIC` checker on "about 9.1",
  or a regex that does not compile.
- `ANSWER_IN_PROMPT` (blocks): the key appears word for word in the prompt.
  Keys under four characters are ignored, and so is a key offered as a choice
  ("Answer Buyer or Seller", "Buyer/Seller", "one of: …").
- `PROMPT_VERY_SHORT` (warns only): under 80 characters.

A blocking finding means no model attempts are made. Paying to learn what is
already known would be waste.

**Model attempts.** The solver gets a short fixed system prompt telling it to end
with `FINAL: <answer>`, and the task prompt as the user message. The last
`FINAL:` line is graded, so a model that corrects itself is marked on the
correction. A reply with no such line is a miss.

**Verdicts** (`decideVerdict`):

| Verdict | Rule | What the reviewer is told |
| --- | --- | --- |
| `ANSWER_LEAK` | Structural leak | Ask the expert to remove it |
| `BROKEN_SPEC` | Any other blocking finding | Ask the expert to fix the checker or key |
| `TOO_EASY` | Solved on every valid attempt | Unlikely to measure anything new |
| `DISCRIMINATING` | Solved on some attempts | Separates models, which is what you want |
| `UNSOLVED` | Never solved | Check the key is right before calling it hard |

An attempt whose API call failed counts neither way. If fewer than half the
requested attempts produced a reply, the check is `INCONCLUSIVE` with a reason,
not a guess, and raises no attention item. An operator can re-run it from the
work item (`POST /api/work-items/:id/task-check`).

### Providers

| `TASK_CHECK_PROVIDER` | What attempts the task | Cost |
| --- | --- | --- |
| `simulated` (default) | A deterministic stand-in: a per-task solve rate from a hash of the prompt, a per-attempt roll from a hash of the submission | None |
| `anthropic` | The Claude API through `@anthropic-ai/sdk` | Billed per attempt |

The simulated provider exists so the demo, the seed and the test suite exercise
the whole pipeline with no network call. Its results are labelled **simulated**
everywhere they appear.

The `anthropic` provider:

- sends `output_config.effort` (default `medium`).
- caches the fixed system prompt.
- turns on server-side refusal fallbacks (`fallbacks: "default"`), so a safety
  decline on, say, a security task is retried on a fallback model rather than
  recorded as a miss.

It records a refusal, a reply cut off before its answer, and any API error as
an errored attempt. Token counts are stored, and an estimated cost comes from
published prices for known models. Unknown models show no cost rather than a
wrong one.

| Variable | Default | Range |
| --- | --- | --- |
| `TASK_CHECK_PROVIDER` | `simulated` | `simulated`, `anthropic` |
| `TASK_CHECK_MODEL` | `claude-opus-5-5` | any model id |
| `TASK_CHECK_EFFORT` | `medium` | `low` … `max` |
| `TASK_CHECK_ATTEMPTS` | `4` | 1–8 |
| `TASK_CHECK_TIMEOUT_MS` | `60000` | 5000–80000 |

Credentials resolve the way the SDK does (`ANTHROPIC_API_KEY`, or a profile from
`ant auth login`).

### Why calling a model inside the job transaction is safe

The worker runs each handler inside one transaction bounded by its 120-second
lease (see [Worker guarantees](limitations.md#worker-guarantees)). A model call
is a request that has left the process, which that document warns about. It is
acceptable here because an attempt only **reads**: it changes nothing anywhere.
If the transaction rolls back after a lease takeover, the attempts are paid for
and lost, and the next run makes its own. Nothing is recorded twice, because
`TaskCheck.submissionId` is unique and the write is an upsert. Attempts run in
parallel, and attempt count and timeout are clamped so a check finishes inside
the lease.

---

## 2. Gold tasks and reviewer calibration

A **gold task** is a task with a known right review decision (`APPROVE` or
`REVISE`) and a rationale. A typical one has a key that is off by one day, a
regex that accepts too much, or a prompt that names its own answer.

- A reviewer is shown their next unanswered gold task **without** the key, and
  answers once. The response reveals whether they matched it, the expected
  decision and the rationale, so a miss teaches straight away.
- `GET /api/quality/gold-tasks`, which includes keys, needs `quality:write`.
  Viewers cannot answer.
- **Calibration score** = correct ÷ answered, shown only after 5 answers. Below
  80% the reviewer is marked *calibration due*. That is a prompt for a
  conversation, and blocks nothing.
- Retiring a gold task keeps the answers already given.

---

## 3. Expert scorecards

Computed when requested, from rows that already exist. Nothing is stored:

- **First-time approval**: approved items never sent back ÷ approved items.
- **On time**: first submissions on or before the due date ÷ items with a due
  date.
- **Flagged checks**: broken, leaking or too-easy checks ÷ completed checks.

Rates stay hidden until an expert has **5 reviewed items**, because two pieces
of work are not a pattern. The scorecard is shown to operators beside the work
it summarises. It is not an input to matching or to any automated decision.

---

## 4. Metrics

`/metrics` (`src/server/services/metrics.ts`) computes, over a 30-, 90- or
365-day window:

- **Funnel**: candidates, then screened, then qualified, in total, by source
  channel and by first-applied domain.
- **Speed**: median days from candidate to first qualification, median hours
  from submission to first review decision, median days from approval to
  payment export.
- **Staffing**: fill rate on open projects, and the dropout rate (confirmed
  seats later released).
- **Delivery**: approved items, first-time approval rate, and cost per approved
  item from batched or exported payments.
- **Task quality**: the verdict mix and the flagged share.

Every rate is returned with its numerator and denominator, and is `null` (shown
as "no data") when the denominator is zero.

---

## Tests

- `tests/unit/task-checks.test.ts`: checkers, answer extraction, structural
  findings including the option-list rule, verdict rules, the simulated
  solver's determinism, config clamping, and the Anthropic solver against a
  fake client (request shape, refusal, truncation, thrown errors).
- `tests/integration/task-quality.test.ts`:
  - submission validation and queueing, idempotent checks, superseded
    revisions, no attempts on a leak, inconclusive runs, the worker handler,
    re-runs.
  - gold-task key hiding, write-once answers, retirement, the calibration
    threshold, API capability checks.
  - scorecard sample thresholds, and metrics on an empty and a populated
    network.

## Not done yet

- **Rubric-graded tasks.** Only exact, numeric and regex checkers exist. Tasks
  marked by a rubric (an LLM judge, or a second human) are not supported.
- **Multi-model panels.** Each check uses one model. Reporting a pass rate per
  model is the natural next step.
- **Environment tasks.** Tasks that need a sandbox, a repository or tools (long
  software-engineering tasks, CVE exploitation) are out of scope. This checks
  single-answer tasks only.
- **Gold tasks mixed into the real queue.** Calibration runs as a separate
  queue, so a reviewer knows when they are answering one.
