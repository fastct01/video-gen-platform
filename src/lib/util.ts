import { createHash, randomBytes } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newApiKey = () => `vk_${randomBytes(32).toString('base64url')}`;
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);
