import type { Request } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const idSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Identifiant invalide.');
export function param(req: Request, name = 'id'): string { return idSchema.parse(req.params[name]); }
export const title = z.string().trim().min(1).max(160);
export const description = z.string().trim().max(4000);
export const position = z.number().int().min(0).max(100000);
export const url = z.union([z.literal(''), z.url().max(2048).refine(v => {
  try { return ['http:', 'https:'].includes(new URL(v).protocol); }
  catch { return false; }
}, 'URL HTTP(S) requise.')]);
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
});
export function pagination(req: Request) {
  const { page, limit } = pageSchema.parse(req.query);
  return { page, limit, skip: (page - 1) * limit };
}
export function list<T>(items: T[], page: number, limit: number) {
  return { items: items.slice(0, limit), page, hasMore: items.length > limit };
}
export const ownerFields = '_id username displayName avatarUrl isGuest';
export function publicUser(user: { _id: unknown; username: string; displayName: string; isGuest?: boolean; bio?: string | null; avatarUrl?: string | null }) {
  return { _id: user._id, username: user.username, displayName: user.displayName, bio: user.bio ?? '', avatarUrl: user.avatarUrl ?? '', isGuest: user.isGuest ?? false };
}