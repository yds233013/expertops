/**
 * Money is stored in minor units (cents) everywhere. These helpers are the only
 * place that converts between the storage form and a display string.
 */
export function centsToDisplay(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function centsToRateDisplay(cents: number, currency = 'USD'): string {
  return `${centsToDisplay(cents, currency)}/h`;
}

export function majorToCents(major: number): number {
  return Math.round(major * 100);
}
