import { type AttentionSeverity } from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';

/**
 * Post new attention items to a Slack channel.
 *
 * Uses an incoming webhook (`SLACK_WEBHOOK_URL`), which posts to one channel
 * and needs no bot token. Unset, the job does nothing and says so.
 *
 * Each item is claimed (`slackNotifiedAt` set where it was null) before the
 * post, inside the job transaction: a second worker blocks on that row and then
 * sees it taken. If the post fails the transaction rolls back and the next run
 * tries again. Slack webhooks have no idempotency key, so a worker that dies
 * after posting but before committing can cause one duplicate message. A
 * duplicate is acceptable for a notification; a missed one is not.
 */
export interface SlackConfig {
  webhookUrl: string | null;
  minSeverity: AttentionSeverity;
  appBaseUrl: string;
}

const SEVERITY_ORDER: AttentionSeverity[] = ['LOW', 'MEDIUM', 'HIGH'];

export function slackConfig(env: Record<string, string | undefined> = process.env): SlackConfig {
  const min = SEVERITY_ORDER.find((value) => value === env.SLACK_MIN_SEVERITY) ?? 'MEDIUM';
  return {
    webhookUrl: env.SLACK_WEBHOOK_URL?.trim() || null,
    minSeverity: min,
    appBaseUrl: (env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  };
}

export function severitiesAtLeast(min: AttentionSeverity): AttentionSeverity[] {
  return SEVERITY_ORDER.slice(SEVERITY_ORDER.indexOf(min));
}

/** Slack mrkdwn treats these three characters as markup. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function attentionMessage(
  item: {
    title: string;
    blocker: string;
    nextAction: string;
    severity: AttentionSeverity;
    kind: string;
  },
  appBaseUrl: string,
) {
  const label = item.kind === 'AUTOMATION_FAILURE' ? 'Automation failure' : 'Needs attention';
  const text = `${label} (${item.severity.toLowerCase()}): ${item.title}`;
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlack(label)}* · ${item.severity.toLowerCase()}\n*${escapeSlack(item.title)}*\n${escapeSlack(item.blocker)}`,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Next: ${escapeSlack(item.nextAction)}` },
          { type: 'mrkdwn', text: `<${appBaseUrl}/attention|Open the attention queue>` },
        ],
      },
    ],
  };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Items older than this are never posted, so turning Slack on does not flood a channel. */
export const SLACK_LOOKBACK_HOURS = 24;
export const SLACK_BATCH = 10;

export async function postAttentionToSlack(
  db: Db,
  options: { config?: SlackConfig; fetch?: FetchLike; now?: Date } = {},
): Promise<{ skipped?: string; posted: number }> {
  const config = options.config ?? slackConfig();
  if (!config.webhookUrl) return { skipped: 'SLACK_WEBHOOK_URL is not set', posted: 0 };
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const at = options.now ?? clockNow();

  const candidates = await db.attentionItem.findMany({
    where: {
      status: 'OPEN',
      slackNotifiedAt: null,
      severity: { in: severitiesAtLeast(config.minSeverity) },
      createdAt: { gte: new Date(at.getTime() - SLACK_LOOKBACK_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: SLACK_BATCH,
  });

  let posted = 0;
  for (const item of candidates) {
    const claimed = await db.attentionItem.updateMany({
      where: { id: item.id, slackNotifiedAt: null },
      data: { slackNotifiedAt: at },
    });
    if (claimed.count === 0) continue;

    const response = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attentionMessage(item, config.appBaseUrl)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Throwing rolls the claims back, so every unposted item is retried.
      throw new Error(
        `Slack returned ${response.status}: ${await response.text().catch(() => '')}`,
      );
    }
    posted += 1;
  }
  return { posted };
}
