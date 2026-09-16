-- Seeded fixtures get natural display names.
--
-- Fixture records were named "NET Ada Nowak 001", "PRACTICE coding review
-- pilot", "SYNTHETIC Client (staging only)". Whether a record may appear in the
-- public demo is now the `demoEligible` column, and the sample-data notice is
-- one label on the page, so the prefixes only made every list harder to read.
--
-- A name prefix is not proof of anything: anybody using the public application
-- form can call themselves "NET Someone". Every rename therefore needs the row
-- to match what a seeding script actually wrote, on more than its name:
--
--   people      the script's fixture address, the exact legacy name that goes
--               with that address, and no application attached anywhere (an
--               application means a person typed the details in);
--   projects    the exact legacy title together with the exact client name the
--               script wrote;
--   listings    the exact legacy title, on a project that passed its check;
--   areas       the exact legacy name under the script's slug, and no other
--               area already using the new name;
--   rubrics     the exact legacy name, in one of those areas;
--   notes/work  the exact legacy text, on a person who passed their check.
--
-- Anything failing a check keeps its name. IDs, references, emails, slugs and
-- relationships are untouched. History is not rewritten: activity summaries,
-- outbox messages, application snapshots, onboarding answers and exported
-- payment batches still say what they said at the time. Each rename appends
-- one activity event carrying the old and the new value.
--
-- scripts/fixture-names.ts holds the same mapping for the seed scripts;
-- tests/integration/fixture-names.test.ts checks that the two agree and that
-- look-alike records are left alone.

CREATE TEMP TABLE fixture_renames (
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  field         text NOT NULL,
  old_value     text NOT NULL,
  new_value     text NOT NULL,
  expert_id     text,
  candidate_id  text,
  project_id    text
);

-- ---------------------------------------------------------------------------
-- Network-exercise people.
--
-- The serial is in both the address (net.<area>.NNN@example.test) and the old
-- name ("NET <Given> <Family> NNN"), and the two must agree. The new name is a
-- bijection on the serial (multiply by 179, coprime with 26 x 26), so no two
-- people are given the same name.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_network_people AS
SELECT
  lower(e."email") AS email,
  e."id" AS expert_id,
  e."fullName" AS old_name,
  (ARRAY['Amara','Bo','Chidi','Dara','Eli','Faye','Gil','Hana','Ines','Jian','Kofi','Lena','Mila',
         'Nils','Oona','Petra','Quinn','Rafa','Sena','Tariq','Ulla','Vik','Wren','Xia','Yusuf',
         'Zara'])[((s.serial * 179) % 676) % 26 + 1]
    || ' ' ||
  (ARRAY['Abiodun','Bergstrom','Castellanos','Dlamini','Eriksen','Farooqi','Gustafsson','Haddad',
         'Ivanova','Jonsdottir','Kowalski','Lindqvist','Mbeki','Nakamura','Oyelaran','Petrova',
         'Quintero','Rasmussen','Sorokin','Tanaka','Ustinov','Vasquez','Wojcik','Xu','Yamada',
         'Zielinski'])[((s.serial * 179) % 676) / 26 + 1] AS new_name
FROM "Expert" e
CROSS JOIN LATERAL (
  SELECT substring(e."email" FROM '^net\.(?:coding|enterprise|cyber)\.([0-9]{3})@example\.test$')::int
    AS serial
) s
WHERE s.serial IS NOT NULL
  AND e."fullName" ~ ('^NET [A-Za-z]+ [A-Za-z]+ ' || lpad(s.serial::text, 3, '0') || '$')
  AND NOT EXISTS (
    SELECT 1 FROM "Candidate" c JOIN "Application" a ON a."candidateId" = c."id"
    WHERE c."expertId" = e."id" OR lower(c."email") = lower(e."email")
  );

CREATE TEMP TABLE fixture_headlines (legacy text PRIMARY KEY, current text NOT NULL);
INSERT INTO fixture_headlines (legacy, current) VALUES
  ('NET network member — PRACTICE Coding', 'Network member — Coding'),
  ('NET network member — PRACTICE Enterprise Business', 'Network member — Enterprise business'),
  ('NET network member — PRACTICE Cybersecurity', 'Network member — Cybersecurity');

-- ---------------------------------------------------------------------------
-- Named people from the staging and practice scripts: address -> legacy name.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_named_people (
  email          text PRIMARY KEY,
  legacy_name    text NOT NULL,
  current_name   text NOT NULL,
  legacy_head    text NOT NULL,
  current_head   text NOT NULL
);
INSERT INTO fixture_named_people VALUES
  ('synthetic.avery.lindqvist@example.test', 'SYNTHETIC Avery Lindqvist', 'Avery Lindqvist',
   'SYNTHETIC staging record — evaluation operations', 'Evaluation operations lead'),
  ('synthetic.bo.okonkwo@example.test', 'SYNTHETIC Bo Okonkwo', 'Bo Okonkwo',
   'SYNTHETIC staging record — clinical operations', 'Clinical operations specialist'),
  ('synthetic.cleo.marchetti@example.test', 'SYNTHETIC Cleo Marchetti', 'Cleo Marchetti',
   'SYNTHETIC staging record — survey methodology', 'Survey methodologist'),
  ('synthetic.dara.nkemelu@example.test', 'SYNTHETIC Dara Nkemelu', 'Dara Nkemelu',
   'SYNTHETIC staging record — programme evaluation', 'Programme evaluation adviser'),
  ('practice.nadia.halvorsen@example.test', 'PRACTICE Nadia Halvorsen', 'Nadia Halvorsen',
   'PRACTICE record — ready to staff', 'Evaluation design lead'),
  ('practice.tomas.ferreira@example.test', 'PRACTICE Tomas Ferreira', 'Tomas Ferreira',
   'PRACTICE record — onboarding not finished', 'Evaluation methodologist'),
  ('practice.ingrid.sorensen@example.test', 'PRACTICE Ingrid Sørensen', 'Ingrid Sørensen',
   'PRACTICE record — holds back as a replacement', 'Senior evaluation designer'),
  ('practice.rosa.imani@example.test', 'PRACTICE Rosa Imani', 'Rosa Imani',
   'PRACTICE applicant — awaiting a screening', 'Evaluation researcher');

-- Experts: names.
INSERT INTO fixture_renames
SELECT 'expert', f.expert_id, 'fullName', f.old_name, f.new_name, f.expert_id, NULL, NULL
FROM fixture_network_people f;

INSERT INTO fixture_renames
SELECT 'expert', e."id", 'fullName', e."fullName", n.current_name, e."id", NULL, NULL
FROM "Expert" e
JOIN fixture_named_people n ON n.email = lower(e."email") AND n.legacy_name = e."fullName"
WHERE NOT EXISTS (
  SELECT 1 FROM "Candidate" c JOIN "Application" a ON a."candidateId" = c."id"
  WHERE c."expertId" = e."id" OR lower(c."email") = lower(e."email")
);

-- Experts: headlines, only on people whose name passed.
INSERT INTO fixture_renames
SELECT 'expert', e."id", 'headline', e."headline", h.current, e."id", NULL, NULL
FROM "Expert" e
JOIN fixture_network_people f ON f.expert_id = e."id"
JOIN fixture_headlines h ON h.legacy = e."headline";

INSERT INTO fixture_renames
SELECT 'expert', e."id", 'headline', e."headline", n.current_head, e."id", NULL, NULL
FROM "Expert" e
JOIN fixture_named_people n ON n.email = lower(e."email") AND n.legacy_head = e."headline"
WHERE EXISTS (
  SELECT 1 FROM fixture_renames r
  WHERE r.entity_type = 'expert' AND r.entity_id = e."id" AND r.field = 'fullName'
);

-- Candidates: the screening-route records the network exercise created, and the
-- practice applicant. Same address, same legacy name, and no application.
INSERT INTO fixture_renames
SELECT 'candidate', c."id", 'fullName', c."fullName", f.new_name, c."expertId", c."id", NULL
FROM "Candidate" c
JOIN fixture_network_people f ON f.email = lower(c."email") AND f.old_name = c."fullName"
WHERE NOT EXISTS (SELECT 1 FROM "Application" a WHERE a."candidateId" = c."id");

INSERT INTO fixture_renames
SELECT 'candidate', c."id", 'fullName', c."fullName", n.current_name, c."expertId", c."id", NULL
FROM "Candidate" c
JOIN fixture_named_people n ON n.email = lower(c."email") AND n.legacy_name = c."fullName"
WHERE NOT EXISTS (SELECT 1 FROM "Application" a WHERE a."candidateId" = c."id");

INSERT INTO fixture_renames
SELECT 'candidate', c."id", 'headline', c."headline",
       COALESCE(h.current, n.current_head), c."expertId", c."id", NULL
FROM "Candidate" c
LEFT JOIN fixture_headlines h ON h.legacy = c."headline"
LEFT JOIN fixture_named_people n ON n.email = lower(c."email") AND n.legacy_head = c."headline"
WHERE COALESCE(h.current, n.current_head) IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM fixture_renames r
    WHERE r.entity_type = 'candidate' AND r.entity_id = c."id" AND r.field = 'fullName'
  );

-- ---------------------------------------------------------------------------
-- Projects: exact title and exact client name, as the scripts wrote them.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_projects (legacy text PRIMARY KEY, current text NOT NULL);
INSERT INTO fixture_projects VALUES
  ('PRACTICE coding review pilot', 'Coding review pilot'),
  ('PRACTICE enterprise process assessment', 'Enterprise process assessment'),
  ('PRACTICE security posture review', 'Security posture review'),
  ('PRACTICE evaluation pilot', 'Evaluation pilot'),
  ('PRACTICE hands-on review pilot', 'Hands-on review pilot'),
  ('SYNTHETIC staging sandbox project', 'Evaluation sandbox');

CREATE TEMP TABLE fixture_verified_projects AS
SELECT p."id", p."title", p."clientName", fp.current
FROM "Project" p
JOIN fixture_projects fp ON fp.legacy = p."title"
WHERE p."clientName" IN (
  'PRACTICE Client (practice only)',
  'PRACTICE Client (hands-on only)',
  'SYNTHETIC Client (staging only)'
);

INSERT INTO fixture_renames
SELECT 'project', v."id", 'title', v."title", v.current, NULL, NULL, v."id"
FROM fixture_verified_projects v;

INSERT INTO fixture_renames
SELECT 'project', v."id", 'clientName', v."clientName", 'Sample client', NULL, NULL, v."id"
FROM fixture_verified_projects v;

-- ---------------------------------------------------------------------------
-- Listings on those projects.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_opportunities (legacy text PRIMARY KEY, current text NOT NULL);
INSERT INTO fixture_opportunities VALUES
  ('PRACTICE code review specialist', 'Code review specialist'),
  ('PRACTICE enterprise process analyst', 'Enterprise process analyst'),
  ('PRACTICE security reviewer', 'Security reviewer'),
  ('PRACTICE hands-on code reviewer', 'Hands-on code reviewer');

CREATE TEMP TABLE fixture_summaries (legacy text PRIMARY KEY, current text NOT NULL);
INSERT INTO fixture_summaries VALUES
  ('Practice listing for PRACTICE Coding.', 'Practice listing for Coding.'),
  ('Practice listing for PRACTICE Enterprise Business.', 'Practice listing for Enterprise business.'),
  ('Practice listing for PRACTICE Cybersecurity.', 'Practice listing for Cybersecurity.');

INSERT INTO fixture_renames
SELECT 'opportunity', o."id", 'title', o."title", fo.current, NULL, NULL, o."projectId"
FROM "Opportunity" o
JOIN fixture_opportunities fo ON fo.legacy = o."title"
JOIN fixture_verified_projects v ON v."id" = o."projectId";

INSERT INTO fixture_renames
SELECT 'opportunity', o."id", 'summary', o."summary", fs.current, NULL, NULL, o."projectId"
FROM "Opportunity" o
JOIN fixture_summaries fs ON fs.legacy = o."summary"
JOIN fixture_verified_projects v ON v."id" = o."projectId";

-- ---------------------------------------------------------------------------
-- Areas and rubrics.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_domains (
  slug text PRIMARY KEY, legacy text NOT NULL, current text NOT NULL
);
INSERT INTO fixture_domains VALUES
  ('practice-coding', 'PRACTICE Coding', 'Coding'),
  ('practice-enterprise-business', 'PRACTICE Enterprise Business', 'Enterprise business'),
  ('practice-cybersecurity', 'PRACTICE Cybersecurity', 'Cybersecurity'),
  ('practice-evaluation', 'PRACTICE Evaluation', 'Evaluation');

INSERT INTO fixture_renames
SELECT 'domain', d."id", 'name', d."name", fd.current, NULL, NULL, NULL
FROM "Domain" d
JOIN fixture_domains fd ON fd.slug = d."slug" AND fd.legacy = d."name"
-- Two areas with one name would be ambiguous in every picker that lists them.
WHERE NOT EXISTS (SELECT 1 FROM "Domain" other WHERE other."name" = fd.current);

CREATE TEMP TABLE fixture_rubrics (legacy text PRIMARY KEY, current text NOT NULL);
INSERT INTO fixture_rubrics VALUES
  ('PRACTICE coding screening', 'Coding screening'),
  ('PRACTICE enterprise screening', 'Enterprise screening'),
  ('PRACTICE security screening', 'Security screening'),
  ('PRACTICE evaluation screening', 'Evaluation screening');

INSERT INTO fixture_renames
SELECT 'rubric', t."id", 'name', t."name", fr.current, NULL, NULL, NULL
FROM "ScreeningTemplate" t
JOIN fixture_rubrics fr ON fr.legacy = t."name"
JOIN "Domain" d ON d."id" = t."domainId"
JOIN fixture_domains fd ON fd.slug = d."slug";

-- ---------------------------------------------------------------------------
-- Availability notes and work-item titles belonging to verified people.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE fixture_verified_experts AS
SELECT DISTINCT entity_id AS id FROM fixture_renames
WHERE entity_type = 'expert' AND field = 'fullName';

INSERT INTO fixture_renames
SELECT 'availability', w."id", 'note', w."note",
       CASE
         WHEN w."note" IN ('NET declared availability', 'PRACTICE availability')
           THEN 'Declared availability'
         ELSE 'Capacity already committed on ' || fp.current
       END,
       w."expertId", NULL, w."projectId"
FROM "AvailabilityWindow" w
JOIN fixture_verified_experts x ON x.id = w."expertId"
LEFT JOIN fixture_projects fp ON w."note" = 'NET capacity already committed on ' || fp.legacy
WHERE w."note" IN ('NET declared availability', 'PRACTICE availability')
   OR fp.legacy IS NOT NULL;

INSERT INTO fixture_renames
SELECT 'work_item', wi."id", 'title', wi."title",
       'Scoping note ' || substring(wi."title" FROM '^NET scoping note ([0-9]+)$'),
       wi."expertId", NULL, wi."projectId"
FROM "WorkItem" wi
JOIN fixture_verified_experts x ON x.id = wi."expertId"
WHERE wi."title" ~ '^NET scoping note [0-9]+$';

-- ---------------------------------------------------------------------------
-- Apply.
-- ---------------------------------------------------------------------------
UPDATE "Expert" e SET "fullName" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'expert' AND r.field = 'fullName' AND r.entity_id = e."id";

UPDATE "Expert" e SET "headline" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'expert' AND r.field = 'headline' AND r.entity_id = e."id";

UPDATE "Candidate" c SET "fullName" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'candidate' AND r.field = 'fullName' AND r.entity_id = c."id";

UPDATE "Candidate" c SET "headline" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'candidate' AND r.field = 'headline' AND r.entity_id = c."id";

UPDATE "Project" p SET "title" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'project' AND r.field = 'title' AND r.entity_id = p."id";

UPDATE "Project" p SET "clientName" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'project' AND r.field = 'clientName' AND r.entity_id = p."id";

UPDATE "Opportunity" o SET "title" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'opportunity' AND r.field = 'title' AND r.entity_id = o."id";

UPDATE "Opportunity" o SET "summary" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'opportunity' AND r.field = 'summary' AND r.entity_id = o."id";

UPDATE "Domain" d SET "name" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'domain' AND r.entity_id = d."id";

UPDATE "ScreeningTemplate" t SET "name" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'rubric' AND r.entity_id = t."id";

UPDATE "AvailabilityWindow" w SET "note" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'availability' AND r.entity_id = w."id";

UPDATE "WorkItem" wi SET "title" = r.new_value
FROM fixture_renames r
WHERE r.entity_type = 'work_item' AND r.entity_id = wi."id";

-- Attention items are the live work queue, not history, and some write a
-- person's name into their title once, when raised, and never refresh it. Left
-- alone, "NET Ada Nowak 001 is staffed with no work" would sit beside a link
-- reading "Ada Nowak". Only items linked to the renamed record are touched.
UPDATE "AttentionItem" ai
SET "title" = replace(ai."title", r.old_value, r.new_value)
FROM fixture_renames r
WHERE r.field = 'fullName'
  AND ((r.entity_type = 'expert' AND ai."expertId" = r.entity_id)
    OR (r.entity_type = 'candidate' AND ai."candidateId" = r.entity_id))
  AND strpos(ai."title", r.old_value) > 0;

UPDATE "AttentionItem" ai
SET "title" = replace(ai."title", r.old_value, r.new_value)
FROM fixture_renames r
WHERE r.entity_type = 'project' AND r.field = 'title'
  AND ai."projectId" = r.entity_id
  AND strpos(ai."title", r.old_value) > 0;

-- ---------------------------------------------------------------------------
-- Record it. Appended, never edited: the old value stays findable.
-- ---------------------------------------------------------------------------
INSERT INTO "ActivityEvent" (
  "id", "actorType", "actorLabel", "entityType", "entityId", "action", "summary",
  "metadata", "projectId", "expertId", "candidateId", "createdAt"
)
SELECT
  'fixrename_' || md5(r.entity_type || ':' || r.entity_id || ':' || r.field),
  'SYSTEM',
  'Migration 20260916100000_fixture_display_names',
  r.entity_type,
  r.entity_id,
  'fixture.renamed',
  'Seeded fixture ' || r.field || ' changed from "' || r.old_value || '" to "' || r.new_value || '"',
  jsonb_build_object('field', r.field, 'from', r.old_value, 'to', r.new_value),
  r.project_id,
  r.expert_id,
  r.candidate_id,
  now()
FROM fixture_renames r;

DROP TABLE fixture_verified_experts, fixture_rubrics, fixture_domains, fixture_summaries,
  fixture_opportunities, fixture_verified_projects, fixture_projects, fixture_named_people,
  fixture_headlines, fixture_network_people, fixture_renames;
