import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setCsrf } from './api';

export type Role = 'OWNER' | 'ADMIN' | 'AGENT';
export interface Me {
  user: { id: string; email: string; name: string; phone: string | null };
  org: { id: string; name: string; plan: string; timezone: string } | null;
  role: Role | null;
  orgs: { id: string; name: string; role: Role }[];
  csrfToken: string;
}
interface Ctx {
  me: Me | null; loading: boolean;
  setMe: (m: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (...roles: Role[]) => boolean;
}
const AuthCtx = createContext<Ctx>(null as unknown as Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const setMe = (m: Me | null) => { if (m) setCsrf(m.csrfToken); setMeState(m); };
  const refresh = async () => {
    try { setMe(await get<Me>('/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  };
  useEffect(() => {
    refresh();
    const h = () => setMeState(null);
    window.addEventListener('mck:unauthorized', h);
    return () => window.removeEventListener('mck:unauthorized', h);
  }, []);
  const logout = async () => { await post('/auth/logout').catch(() => undefined); setMeState(null); };
  const can = (...roles: Role[]) => !!me?.role && roles.includes(me.role);
  return <AuthCtx.Provider value={{ me, loading, setMe, refresh, logout, can }}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);
export const ROLE_LABEL: Record<Role, string> = { OWNER: 'Proprietário', ADMIN: 'Administrador', AGENT: 'Atendente' };
