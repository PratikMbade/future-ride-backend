// src/services/registeruser.service.ts
import { isUserExist }           from '../utils/userMethod';
import { prisma }                from '..';
import { generationTreeService } from './generationtree.service';

export const registerUserService = async (
  userAddress:     string,
  referralAddress: string,
  contractRegId:   number,
) => {
  try {
    const normalizedAddress  = userAddress.toLowerCase();
    const normalizedReferral = referralAddress.toLowerCase();

    // ── idempotency check ─────────────────────────────────
    const existing = await prisma.user.findUnique({
      where:  { userAddress: normalizedAddress },
      select: { isRegistered: true },
    });
    if (existing?.isRegistered === true) {
      throw new Error('User already registered in contract');
    }

    // ── referral must exist ───────────────────────────────
    const isReferralExist = await isUserExist(normalizedReferral);
    if (!isReferralExist) throw new Error('Referral not present in DB');

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
      },
      create: {
        userAddress:    normalizedAddress,
        referalAddress: normalizedReferral,
        contractRegId,
        isRegistered:   true,
      },
    });

    console.log(`✅ Registered: ${normalizedAddress} → #${contractRegId}`);

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