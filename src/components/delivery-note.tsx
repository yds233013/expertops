import {
  deliveryMode,
  SIMULATED_DELIVERY_NOTE,
  SIMULATED_DELIVERY_SHORT,
} from '@/lib/delivery-mode';
import { Badge } from '@/components/ui';

/**
 * States plainly that nothing was emailed.
 *
 * Used anywhere a status reads as delivery — an invitation marked "sent", the
 * outbox, a screening invitation — because "sent" is the word a person will
 * believe unless told otherwise, and believing it during a pilot means assuming
 * a participant has seen something they have not.
 */
export function SimulatedDeliveryBadge({ title }: { title?: string }) {
  if (deliveryMode() === 'external') return null;
  return (
    <Badge tone="muted" title={title ?? SIMULATED_DELIVERY_NOTE}>
      not emailed
    </Badge>
  );
}

export function SimulatedDeliveryNote({ className }: { className?: string }) {
  if (deliveryMode() === 'external') return null;
  return (
    <p className={className ?? 'text-xs text-ink-600'}>
      <span className="font-semibold">{SIMULATED_DELIVERY_SHORT}</span> {SIMULATED_DELIVERY_NOTE}
    </p>
  );
}
