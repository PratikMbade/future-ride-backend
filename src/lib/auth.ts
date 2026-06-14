// src/lib/auth.ts
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { siwe } from 'better-auth/plugins';
import { PrismaClient } from '@prisma/client';
import { generateNonce, SiweMessage } from 'siwe';

const prisma = new PrismaClient();


prisma.$use(async (params, next) => {
  if (params.model === 'User' && params.action === 'create') {
    const data = params.args.data;
    const walletAddress = (data.name as string)?.toLowerCase() ?? '';

    if (walletAddress.startsWith('0x')) {
      // check if user already exists (e.g. seeded owner)
      const existing = await prisma.user.findUnique({
        where: { userAddress: walletAddress },
      });

      if (existing) {
        // user already in DB — switch create → update so better-auth
        // gets back a valid user record without hitting unique constraint
        params.action    = 'update';
        params.args      = {
          where: { userAddress: walletAddress },
          data:  {
            // update only safe fields — don't overwrite contractRegId or isRegistered
            name:          data.name,
            emailVerified: data.emailVerified ?? false,
            updatedAt:     new Date(),
          },
        };
        return next(params);
      }

      // new user — inject userAddress and clean fake email
      params.args.data = {
        ...data,
        userAddress: walletAddress,
        email: typeof data.email === 'string' && data.email.includes('@http')
          ? undefined
          : data.email,
      };
    }
  }

  return next(params);
});

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    'https://ficon.space',
    'https://www.ficon.space',
    'https://api.ficon.space',
        'https://www.api.ficon.space',
    'https://auth.ficon.space',
    'https://www.auth.ficon.space',
    // dev
    'http://localhost:3000',
    'http://localhost:4000',
  ],
   advanced: {
    cookiePrefix: 'ficon',
    crossSubDomainCookies: {
      enabled: true,
      domain:  '.ficon.space',   // shared across *.ficon.space
    },
    defaultCookieAttributes: {
      secure:   true,
      httpOnly: true,
      sameSite: 'none',          // required for cross-subdomain cookies
      path:     '/',
    },
  },
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  plugins: [
    siwe({
      domain: process.env.FRONTEND_DOMAIN ?? 'localhost:5173',
      getNonce: async () => generateNonce(),
      verifyMessage: async ({ message, signature }) => {
        try {
          const siweMessage = new SiweMessage(message);
          const result = await siweMessage.verify({ signature });
          return result.success;
        } catch {
          return false;
        }
      },
    }),
  ],

});