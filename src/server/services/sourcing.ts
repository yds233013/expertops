import { type Prisma, type SourcingCampaign, type SourcingCampaignStatus } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import { formatReference, parseReferenceSequence, slugify } from '@/lib/ids';
import { type Actor, recordActivity } from './activity';

/**
 * Sourcing campaigns.
 *
 * A campaign exists because the network cannot currently satisfy demand. Tying
 * it to the project that is short means the operator can see whether recruiting
 * effort is actually aimed at the gap they have.
 */
export const CAMPAIGN_REFERENCE_PREFIX = 'SRC';

async function nextCampaignCode(db: Db): Promise<string> {
  // Only well-formed references count towards the sequence; see
  // nextExpertReference for why lexical MAX is unsafe here.
  const rows = await db.sourcingCampaign.findMany({
    where: { code: { startsWith: `${CAMPAIGN_REFERENCE_PREFIX}-` } },
    select: { code: true },
  });

  let highest = 0;
  for (const row of rows) {
    const sequence = parseReferenceSequence(CAMPAIGN_REFERENCE_PREFIX, row.code);
    if (sequence > highest) highest = sequence;
  }
  return formatReference(CAMPAIGN_REFERENCE_PREFIX, highest + 1);
}

export interface CreateCampaignInput {
  name: string;
  domainId: string;
  projectId?: string | null;
  targetCount?: number;
  ownerId?: string | null;
  notes?: string;
  closesAt?: Date | null;
}

export async function createCampaign(
  db: Db,
  actor: Actor,
  input: CreateCampaignInput,
): Promise<SourcingCampaign> {
  if (!input.name.trim()) throw badRequest('Campaign name is required.');
  const target = input.targetCount ?? 1;
  if (!Number.isInteger(target) || target < 1 || target > 500) {
    throw badRequest('Target count must be between 1 and 500.');
  }

  const domain = await db.domain.findUnique({ where: { id: input.domainId } });
  if (!domain) throw notFound('Domain not found.');

  if (input.projectId) {
    const project = await db.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw notFound('Project not found.');
  }

  const campaign = await db.sourcingCampaign.create({
    data: {
      code: await nextCampaignCode(db),
      name: input.name.trim(),
      domainId: input.domainId,
      projectId: input.projectId ?? null,
      targetCount: target,
      ownerId: input.ownerId ?? actor.userId ?? null,
      notes: input.notes?.trim() ?? '',
      closesAt: input.closesAt ?? null,
      createdById: actor.userId ?? null,
      status: 'DRAFT',
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'campaign',
    entityId: campaign.id,
    projectId: campaign.projectId,
    action: 'campaign.created',
    summary: `Sourcing campaign ${campaign.code} "${campaign.name}" opened for ${domain.name}`,
    metadata: { targetCount: target, domainId: domain.id, projectId: campaign.projectId },
  });

  return campaign;
}

const CAMPAIGN_TRANSITIONS: Record<SourcingCampaignStatus, SourcingCampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['PAUSED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export async function setCampaignStatus(
  db: Db,
  actor: Actor,
  campaignId: string,
  to: SourcingCampaignStatus,
): Promise<SourcingCampaign> {
  const campaign = await db.sourcingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw notFound('Campaign not found.');
  if (campaign.status === to) return campaign;

  const allowed = CAMPAIGN_TRANSITIONS[campaign.status];
  if (!allowed.includes(to)) {
    throw invalidState(
      `Campaign cannot move from ${campaign.status} to ${to}. Allowed: ${allowed.join(', ') || 'none'}.`,
    );
  }

  const updated = await db.sourcingCampaign.update({
    where: { id: campaignId },
    data: {
      status: to,
      opensAt: to === 'ACTIVE' && !campaign.opensAt ? clockNow() : campaign.opensAt,
    },
  });

  await recordActivity(db, {
    actor,
    entityType: 'campaign',
    entityId: campaignId,
    projectId: campaign.projectId,
    action: 'campaign.status_changed',
    summary: `Campaign ${campaign.code} moved from ${campaign.status} to ${to}`,
    metadata: { from: campaign.status, to },
  });
  return updated;
}

export async function listCampaigns(
  db: Db,
  query: { status?: SourcingCampaignStatus; projectId?: string; limit?: number } = {},
) {
  const where: Prisma.SourcingCampaignWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.projectId) where.projectId = query.projectId;

  return db.sourcingCampaign.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }],
    take: Math.min(query.limit ?? 50, 200),
    include: {
      domain: true,
      project: { select: { id: true, code: true, title: true, status: true } },
      owner: { select: { id: true, name: true } },
      _count: { select: { candidates: true } },
    },
  });
}

export async function getCampaign(db: Db, campaignId: string) {
  const campaign = await db.sourcingCampaign.findUnique({
    where: { id: campaignId },
    include: {
      domain: true,
      project: true,
      owner: { select: { id: true, name: true, email: true } },
      candidates: {
        orderBy: { createdAt: 'desc' },
        include: { sourceChannel: true, screenings: { take: 1, orderBy: { createdAt: 'desc' } } },
      },
    },
  });
  if (!campaign) throw notFound('Campaign not found.');
  return campaign;
}

/** Progress against the campaign's target, used by the campaign screen. */
export async function campaignProgress(db: Db, campaignId: string) {
  const campaign = await db.sourcingCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw notFound('Campaign not found.');

  const grouped = await db.candidate.groupBy({
    by: ['stage'],
    where: { campaignId },
    _count: { _all: true },
  });
  const byStage = Object.fromEntries(grouped.map((row) => [row.stage, row._count._all]));
  const qualified = byStage.QUALIFIED ?? 0;

  return {
    targetCount: campaign.targetCount,
    qualified,
    inPipeline:
      (byStage.NEW ?? 0) +
      (byStage.SCREENING_INVITED ?? 0) +
      (byStage.SCREENING_SUBMITTED ?? 0) +
      (byStage.IN_REVIEW ?? 0) +
      (byStage.REVISION_REQUESTED ?? 0),
    byStage,
    shortfall: Math.max(0, campaign.targetCount - qualified),
  };
}

// ---------------------------------------------------------------------------
// Source channels
// ---------------------------------------------------------------------------

export async function upsertSourceChannel(
  db: Db,
  input: {
    name: string;
    kind?: 'REFERRAL' | 'COMMUNITY' | 'DIRECT_APPLICATION' | 'EVENT' | 'IMPORT' | 'OTHER';
    notes?: string;
  },
) {
  const slug = slugify(input.name);
  if (!slug) throw badRequest('Source channel name cannot be blank.');
  return db.sourceChannel.upsert({
    where: { slug },
    update: {},
    create: {
      slug,
      name: input.name.trim(),
      kind: input.kind ?? 'OTHER',
      notes: input.notes?.trim() ?? '',
    },
  });
}

export async function listSourceChannels(db: Db) {
  return db.sourceChannel.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    include: { _count: { select: { candidates: true } } },
  });
}

/**
 * Which channels actually produce qualified experts.
 *
 * Counting qualified outcomes rather than raw volume keeps the operator's
 * attention on relationships that work.
 */
export async function sourceChannelEffectiveness(db: Db) {
  const channels = await db.sourceChannel.findMany({
    include: {
      candidates: { select: { stage: true } },
    },
  });

  return channels
    .map((channel) => {
      const total = channel.candidates.length;
      const qualified = channel.candidates.filter((c) => c.stage === 'QUALIFIED').length;
      const rejected = channel.candidates.filter((c) => c.stage === 'REJECTED').length;
      return {
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        total,
        qualified,
        rejected,
        inFlight: total - qualified - rejected,
        // Null rather than zero when there is nothing to judge yet.
        qualifiedRate: total > 0 ? Math.round((qualified / total) * 100) : null,
      };
    })
    .sort((a, b) => b.qualified - a.qualified);
}
