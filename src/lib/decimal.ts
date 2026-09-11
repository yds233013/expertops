/**
 * Precise monetary arithmetic.
 *
 * Money is always an integer count of minor units (cents). Quantities (hours,
 * deliverable counts) carry two decimal places and are handled as scaled
 * integers, so `0.1 + 0.2` problems cannot reach a payment row.
 *
 * Prisma returns Decimal columns as a Decimal.js-like object; `toQuantity`
 * normalises whatever shape arrives into a scaled integer before any
 * calculation happens.
 */
export const QUANTITY_SCALE = 100; // two decimal places

export type QuantityInput = number | string | { toString(): string };

/** Parse a quantity into hundredths, rejecting anything that is not a number. */
export function toQuantityScaled(value: QuantityInput): number {
  const text = typeof value === 'string' ? value : String(value);
  const trimmed = text.trim();

  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid quantity.`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  // Round half-up at the second decimal place rather than truncating, so
  // 1.005 becomes 1.01 and not 1.00.
  const padded = `${fraction}000`.slice(0, 3);
  const hundredths = Number(padded.slice(0, 2));
  const thousandth = Number(padded[2] ?? '0');
  let scaled = Number(whole) * QUANTITY_SCALE + hundredths;
  if (thousandth >= 5) scaled += 1;

  return negative ? -scaled : scaled;
}

export function quantityToString(scaled: number): string {
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const whole = Math.floor(abs / QUANTITY_SCALE);
  const fraction = String(abs % QUANTITY_SCALE).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * amount = quantity x rate, in minor units.
 *
 * Both inputs are integers (hundredths of a unit, and minor currency units), so
 * the product is exact. Only the final division rounds, half-up.
 */
export function computeAmountMinor(quantityScaled: number, rateMinor: number): number {
  if (!Number.isInteger(rateMinor)) {
    throw new Error('Rate must be an integer number of minor units.');
  }
  if (!Number.isInteger(quantityScaled)) {
    throw new Error('Quantity must already be scaled to an integer.');
  }

  const product = quantityScaled * rateMinor; // exact: integer x integer
  const negative = product < 0;
  const abs = Math.abs(product);

  const whole = Math.floor(abs / QUANTITY_SCALE);
  const remainder = abs % QUANTITY_SCALE;
  // Round half-up on the remainder.
  const rounded = remainder * 2 >= QUANTITY_SCALE ? whole + 1 : whole;

  return negative ? -rounded : rounded;
}

/** Sum minor-unit amounts, guarding against silent precision loss. */
export function sumMinor(amounts: number[]): number {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) {
      throw new Error(`Refusing to sum a non-integer minor amount: ${amount}`);
    }
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new Error('Payment total exceeded the safe integer range.');
    }
  }
  return total;
}

export function formatMinor(amountMinor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/** Plain decimal string for CSV, with no currency symbol or thousands separator. */
export function minorToPlainDecimal(amountMinor: number): string {
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
