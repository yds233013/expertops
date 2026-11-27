/**
 * Who actually delivers an outbox message.
 *
 * `simulated` (the default) delivers nothing: the worker marks the row SENT and
 * the operator Outbox screen is the only place the message exists. `resend`
 * sends it through the Resend HTTP API.
 *
 * The real provider is called from inside the worker's job transaction, which
 * the limitations doc warns about: a rollback cannot recall an email. Two
 * things make it safe here:
 *
 *  - Every send carries `Idempotency-Key: outbox-<message id>`. Resend returns
 *    the original result for a repeated key for 24 hours, so a retry after a
 *    rollback or a lease takeover does not send a second email.
 *  - The status change is a conditional update on `status = QUEUED`, so two
 *    workers that both reach the same row record it once.
 */
export interface OutgoingEmail {
  id: string;
  to: string;
  toName: string;
  subject: string;
  text: string;
}

export type SendOutcome =
  | { kind: 'sent'; providerMessageId: string | null }
  /** Worth trying again later: rate limits, server errors, network trouble. */
  | { kind: 'retry'; error: string }
  /** Will never succeed as written: a rejected address, a bad request. */
  | { kind: 'failed'; error: string };

export interface EmailProvider {
  readonly name: 'simulated' | 'resend';
  send(email: OutgoingEmail): Promise<SendOutcome>;
}

export class SimulatedEmailProvider implements EmailProvider {
  readonly name = 'simulated' as const;
  async send(): Promise<SendOutcome> {
    return { kind: 'sent', providerMessageId: null };
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Injected in tests. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ResendOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `outbox-${email.id}`,
        },
        body: JSON.stringify({
          from: this.options.from,
          to: [email.toName ? `${email.toName.replace(/[<>"]/g, '')} <${email.to}>` : email.to],
          subject: email.subject,
          text: email.text,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      return {
        kind: 'retry',
        error: `Could not reach Resend: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      id?: string;
      message?: string;
      name?: string;
    } | null;
    const detail = body?.message ?? body?.name ?? response.statusText;

    if (response.ok) return { kind: 'sent', providerMessageId: body?.id ?? null };
    // 409 is a concurrent request with the same idempotency key: the other
    // one is still in flight, so try again rather than give up.
    if (response.status === 429 || response.status === 409 || response.status >= 500) {
      return { kind: 'retry', error: `Resend ${response.status}: ${detail}` };
    }
    return { kind: 'failed', error: `Resend ${response.status}: ${detail}` };
  }
}

// ---------------------------------------------------------------------------
// Configuration and recipient guard
// ---------------------------------------------------------------------------

export interface EmailConfig {
  provider: 'simulated' | 'resend';
  apiKey: string | null;
  from: string | null;
  /** Lower-cased domains. Empty means any domain that is not reserved. */
  allowedDomains: string[];
  webhookSecret: string | null;
}

export function emailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
  return {
    provider: env.EMAIL_PROVIDER === 'resend' ? 'resend' : 'simulated',
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.EMAIL_FROM?.trim() || null,
    allowedDomains: (env.EMAIL_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
    webhookSecret: env.RESEND_WEBHOOK_SECRET?.trim() || null,
  };
}

export class EmailConfigError extends Error {}

/** Build the provider, or explain exactly which setting is missing. */
export function emailProviderFor(config: EmailConfig, fetchImpl?: FetchLike): EmailProvider {
  if (config.provider === 'simulated') return new SimulatedEmailProvider();
  if (!config.apiKey) throw new EmailConfigError('EMAIL_PROVIDER=resend needs RESEND_API_KEY.');
  if (!config.from) {
    throw new EmailConfigError(
      'EMAIL_PROVIDER=resend needs EMAIL_FROM, on a domain verified in Resend.',
    );
  }
  return new ResendEmailProvider({ apiKey: config.apiKey, from: config.from, fetch: fetchImpl });
}

/**
 * Domains that can never receive mail (RFC 2606 and RFC 6761). The seed and
 * every fixture use them, so a real provider pointed at a seeded database
 * sends nothing instead of bouncing hundreds of messages.
 */
const RESERVED_SUFFIXES = ['.test', '.example', '.invalid', '.localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

export function domainOf(email: string): string {
  return email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
}

/** Why this address must not be sent to, or null when it may be. */
export function recipientBlockReason(email: string, config: EmailConfig): string | null {
  const domain = domainOf(email);
  if (
    RESERVED_DOMAINS.includes(domain) ||
    RESERVED_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix))
  ) {
    return `${domain} is a reserved test domain and cannot receive mail.`;
  }
  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(domain)) {
    return `${domain} is not in EMAIL_ALLOWED_DOMAINS.`;
  }
  return null;
}
