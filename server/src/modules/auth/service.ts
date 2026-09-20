// JWT login over the User table (Phase 11 item 4). The three demo bearer tokens keep working as a
// fallback (middleware/auth.ts), so the README instructions and the tests stay valid.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { unauthorizedError } from '../../errors/AppError.js';
import type { Principal, Role } from '../../middleware/auth.js';
import { verifyPassword } from './passwords.js';

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export interface UserDto {
  user_id: string;
  email: string;
  name: string;
  role: Role;
}

export interface LoginResponse {
  token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: UserDto;
}

const ROLES: readonly Role[] = ['support_agent', 'support_manager', 'admin'];

interface TokenClaims {
  sub: string;
  role: Role;
  email: string;
  name: string;
}

export async function login(body: LoginBody): Promise<LoginResponse> {
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Same error for an unknown email and a wrong password, so the response does not reveal which.
  if (!user || !verifyPassword(body.password, user.passwordHash)) throw unauthorizedError('Invalid email or password');
  if (!ROLES.includes(user.role as Role)) throw unauthorizedError(`User ${user.userId} has an unknown role`);
  const claims: TokenClaims = { sub: user.userId, role: user.role as Role, email: user.email, name: user.name };
  const token = jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.JWT_TTL_SECONDS, issuer: 'trustdesk' });
  return {
    token,
    token_type: 'Bearer',
    expires_in: env.JWT_TTL_SECONDS,
    user: { user_id: user.userId, email: user.email, name: user.name, role: user.role as Role },
  };
}

/** Verifies a JWT issued by login(); returns null for anything that is not a valid, unexpired TrustDesk token. */
export function principalFromJwt(token: string): Principal | null {
  if (token.split('.').length !== 3) return null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { issuer: 'trustdesk' });
    if (typeof payload !== 'object' || payload === null) return null;
    const { sub, role } = payload as Partial<TokenClaims>;
    if (typeof sub !== 'string' || !role || !ROLES.includes(role)) return null;
    return { userId: sub, role };
  } catch {
    return null;
  }
}

export async function currentUser(principal: Principal): Promise<UserDto> {
  const user = await prisma.user.findUnique({ where: { userId: principal.userId } });
  // Demo-token principals have no row of their own (usr_agent etc. are seeded, so normally they do).
  return user
    ? { user_id: user.userId, email: user.email, name: user.name, role: user.role as Role }
    : { user_id: principal.userId, email: '', name: principal.userId, role: principal.role };
}
