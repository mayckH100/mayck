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
        /** Titular (OWNER) sem CPF/CNPJ ou celular: só as rotas de /api/auth funcionam até completar o cadastro. */
        needsCadastro?: boolean;
      };
      rawBody?: Buffer;
    }
  }
}
export {};
