import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const digest = (token: string) => createHash('sha256').update(token).digest();

export class BrowserSession {
  private bootstrapDigest: Buffer | null;
  private readonly bootstrapExpires: number;
  private sessionDigest: Buffer | null = null;
  private sessionExpires = 0;

  constructor(bootstrapToken: string, private readonly now: () => number = () => performance.now()) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) throw new Error('Invalid bootstrap token');
    this.bootstrapDigest = digest(bootstrapToken);
    this.bootstrapExpires = now() + BOOTSTRAP_TTL_MS;
  }

  exchange(token: string): string | null {
    if (this.now() >= this.bootstrapExpires) this.bootstrapDigest = null;
    if (!this.bootstrapDigest || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !timingSafeEqual(digest(token), this.bootstrapDigest)) return null;
    const sessionToken = randomBytes(32).toString('base64url');
    // Consume synchronously, before any response or asynchronous work.
    this.bootstrapDigest = null;
    this.sessionDigest = digest(sessionToken);
    this.sessionExpires = this.now() + SESSION_TTL_MS;
    return sessionToken;
  }

  accepts(cookie: string | undefined, port: number): boolean {
    if (this.now() >= this.sessionExpires) this.sessionDigest = null;
    if (!this.sessionDigest || !cookie) return false;
    const prefix = `${cookieName(port)}=`;
    const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
    if (matches.length !== 1) return false;
    const token = matches[0]!.slice(prefix.length);
    return /^[A-Za-z0-9_-]{43}$/.test(token) && timingSafeEqual(digest(token), this.sessionDigest);
  }
}

// Cookies are not port scoped; separate names avoid collisions between NoteTrail instances.
export const cookieName = (port: number) => `notetrail_session_${port}`;
export const sessionCookie = (token: string, port: number) =>
  `${cookieName(port)}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
