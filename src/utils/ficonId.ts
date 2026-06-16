// src/utils/ficonId.ts
// Generates a deterministic numeric FICON ID from a wallet address.
//
// Algorithm:
//   1. Take the last 10 hex characters of the wallet address
//   2. Map each hex char to a digit 0-9:
//      0-9 → same digit
//      A/a → 1,  B/b → 2,  C/c → 3,  D/d → 4,
//      E/e → 5,  F/f → 6
//   3. Result is a pure 10-digit numeric string e.g. "7626634343"
//
// Deterministic: same wallet → same ID always (DB-reset safe).
// Collision fallback: extends to 12, 14, 16 chars if needed.

const HEX_MAP: Record<string, string> = {
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  'a': '1', 'b': '2', 'c': '3', 'd': '4', 'e': '5', 'f': '6',
};

function hexToFiconDigits(hex: string): string {
  return hex.toLowerCase().split('').map(c => HEX_MAP[c] ?? '0').join('');
}

/**
 * Generate a FICON ID from a wallet address.
 * Returns a pure numeric string — no prefix.
 *
 * Example:
 *   0x2C7f4dB6A0B1df04EA8550c219318C7f2FF3D34C
 *   last 10 chars → "7f2ff3d34c"
 *   mapped        → "7626634343"
 */
export function generateFiconId(userAddress: string, length = 10): string {
  const clean   = userAddress.replace(/^0x/i, '').toLowerCase();
  const segment = clean.slice(-length);
  return hexToFiconDigits(segment);
}

/**
 * Generate a FICON ID with collision handling.
 * Tries lengths [10, 12, 14, 16] until a unique one is found.
 */
export async function generateUniqueFiconId(
  userAddress: string,
  checkExists: (ficonId: string) => Promise<boolean>,
): Promise<string> {
  for (const length of [10, 12, 14, 16]) {
    const ficonId = generateFiconId(userAddress, length);
    const exists  = await checkExists(ficonId);
    if (!exists) return ficonId;
  }

  // absolute fallback — practically unreachable
  const clean  = userAddress.replace(/^0x/i, '').toLowerCase();
  return hexToFiconDigits(clean);
}