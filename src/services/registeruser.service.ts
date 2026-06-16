// src/services/registeruser.service.ts
import { isUserExist }         from '../utils/userMethod';
import { prisma }              from '..';
import { generationTreeService } from './generationtree.service';
import { generateUniqueFiconId } from '../utils/ficonId';

export const registerUserService = async (
  userAddress:   string,
  referralAddress: string,
  contractRegId: number,
) => {
  try {
    const normalizedAddress  = userAddress.toLowerCase();
    const normalizedReferral = referralAddress.toLowerCase();

    // ── idempotency check ─────────────────────────────────
    const existing = await prisma.user.findUnique({
      where:  { userAddress: normalizedAddress },
      select: { isRegistered: true, ficonId: true },
    });
    if (existing?.isRegistered === true) {
      throw new Error('User already registered in contract');
    }

    // ── referral must exist ───────────────────────────────
    const isReferralExist = await isUserExist(normalizedReferral);
    if (!isReferralExist) throw new Error('Referral not present in DB');

    // ── generate deterministic FICON ID ───────────────────
    // Reuse existing ficonId if user already has one (was pre-seeded or
    // connected wallet before registering on-chain).
    const ficonId = existing?.ficonId ?? await generateUniqueFiconId(
      normalizedAddress,
      async (id) => {
        const taken = await prisma.user.findUnique({
          where:  { ficonId: id },
          select: { id: true },
        });
        return !!taken;
      }
    );

    // ── upsert ────────────────────────────────────────────
    // Handles:
    //   1. User connected wallet before → row exists → update
    //   2. Fresh user → create
    const user = await prisma.user.upsert({
      where:  { userAddress: normalizedAddress },
      update: {
        referalAddress: normalizedReferral,
        contractRegId,
        isRegistered:   true,
        ficonId,
      },
      create: {
        userAddress:    normalizedAddress,
        referalAddress: normalizedReferral,
        contractRegId,
        isRegistered:   true,
        ficonId,
      },
    });

    console.log(`✅ Registered: ${normalizedAddress} → ${ficonId}`);

    // fire-and-forget generation tree (non-blocking)
    generationTreeService(normalizedAddress).catch(err =>
      console.error('generationTreeService error:', err.message)
    );

    return user;

  } catch (error: any) {
    console.error('❌ registerUserService error:', error.message);
    throw error;
  }
};