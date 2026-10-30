export type Role = 'OWNER' | 'ADMIN' | 'AGENT';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        sessionId: string;
        csrfToken: string;
        orgId: string | null;
        role: Role | null;
        isSuperAdmin: boolean;
        mfaEnabled: boolean;
      };
      rawBody?: Buffer;
    }
  }
}
export {};
