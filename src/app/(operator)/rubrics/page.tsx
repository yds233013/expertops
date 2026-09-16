import { prisma } from '@/lib/db';
import { formatDateTime } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listTemplates } from '@/server/services/screening';
import { listDomains } from '@/server/services/qualifications';
import { CreateTemplateForm, NewDraftButton } from '@/components/rubric-actions';
import { RubricEditor } from '@/components/rubric-editor';
import { Badge, Card, EmptyState, ProvenanceTag, StatusBadge, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Rubric authoring.
 *
 * The central rule is visible on the page rather than buried in a service: a
 * published version is read-only and shows the screenings recorded against it,
 * and changing a rubric means drafting the next version.
 */
export default async function RubricsPage() {
  const operator = await requireOperator();
  const [templates, domains] = await Promise.all([listTemplates(prisma), listDomains(prisma)]);

  const canWrite = roleHasCapability(operator.role, 'rubric:write');
  const canPublish = roleHasCapability(operator.role, 'rubric:publish');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sourcing"
        title="Screening rubrics"
        description="A published version never changes. Screenings keep the version they started against, so a decision made months ago is still explainable."
      />

      {canWrite && (
        <Card
          title="New template"
          description="One template per assessment; versions live inside it."
          actions={<ProvenanceTag kind="operator" />}
        >
          {domains.length === 0 ? (
            <EmptyState title="No domains yet" hint="A template belongs to a domain." />
          ) : (
            <CreateTemplateForm domains={domains.map((d) => ({ id: d.id, name: d.name }))} />
          )}
        </Card>
      )}

      {templates.length === 0 ? (
        <Card>
          <EmptyState title="No screening templates" />
        </Card>
      ) : (
        templates.map((template) => {
          const draft = template.versions.find((version) => version.status === 'DRAFT');
          const nextVersion = (template.versions[0]?.version ?? 0) + 1;

          return (
            <Card
              key={template.id}
              title={template.name}
              description={`${template.domain.name}${template.description ? ` · ${template.description}` : ''}`}
              actions={
                canWrite && !draft ? (
                  <NewDraftButton
                    templateId={template.id}
                    nextVersion={nextVersion}
                    isFirstVersion={template.versions.length === 0}
                  />
                ) : draft ? (
                  <Badge tone="warning">draft v{draft.version} open</Badge>
                ) : null
              }
            >
              <div className="space-y-4">
                {template.versions.length === 0 && (
                  <EmptyState
                    title="No versions yet"
                    hint="Start a draft to define the criteria."
                  />
                )}

                {template.versions.map((version) => (
                  <section
                    key={version.id}
                    className="rounded-lg border border-ink-200 px-3 py-3"
                    aria-labelledby={`version-${version.id}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        id={`version-${version.id}`}
                        className="text-sm font-semibold text-ink-900"
                      >
                        Version {version.version}
                      </h3>
                      <StatusBadge status={version.status} />
                      <Badge tone="muted">
                        {version._count.screenings} screening
                        {version._count.screenings === 1 ? '' : 's'} recorded
                      </Badge>
                      {version.publishedAt && (
                        <span className="text-xs text-ink-500">
                          published {formatDateTime(version.publishedAt)}
                        </span>
                      )}
                    </div>

                    {version.changeNote && (
                      <p className="mt-1 text-xs text-ink-600">{version.changeNote}</p>
                    )}

                    {version.status === 'DRAFT' && canWrite ? (
                      <div className="mt-3">
                        <RubricEditor
                          versionId={version.id}
                          versionNumber={version.version}
                          templateName={template.name}
                          canPublish={canPublish}
                          initialPassThreshold={version.passThreshold}
                          initialGuidance={version.guidance}
                          initialChangeNote={version.changeNote}
                          initialCriteria={version.criteria.map((criterion) => ({
                            key: criterion.key,
                            label: criterion.label,
                            scoringGuidance: criterion.scoringGuidance,
                            maxScore: criterion.maxScore,
                            weight: criterion.weight,
                            requiredEvidence: criterion.requiredEvidence,
                            isGating: criterion.isGating,
                          }))}
                        />
                      </div>
                    ) : (
                      <div className="mt-2 space-y-2">
                        <p className="text-xs text-ink-600">
                          Pass threshold {version.passThreshold}.{' '}
                          {version.status === 'PUBLISHED' &&
                            'This version is immutable; edit by drafting the next one.'}
                        </p>
                        <ul className="space-y-1">
                          {version.criteria.map((criterion) => (
                            <li
                              key={criterion.id}
                              className="flex flex-wrap items-center gap-2 border-b border-ink-100 py-1.5 text-sm last:border-b-0"
                            >
                              <span className="font-medium text-ink-900">{criterion.label}</span>
                              <Badge tone="muted">
                                max {criterion.maxScore} × weight {criterion.weight}
                              </Badge>
                              {criterion.requiredEvidence !== 'NONE' && (
                                <Badge tone="info">
                                  {criterion.requiredEvidence.replace(/_/g, ' ').toLowerCase()}
                                </Badge>
                              )}
                              {criterion.isGating && <Badge tone="danger">gating</Badge>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                ))}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
