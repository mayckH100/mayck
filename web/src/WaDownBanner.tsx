import { useEffect, useState } from 'react';
import { get } from './api';
import { useAuth } from './auth';

export interface WaDownAlerts {
  down: { id: string; label: string; downSince: string | null; alertedAt: string | null }[];
  back: { id: string; label: string; backAt: string }[];
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtWaDownSince = fmt;

/** Alertas de WhatsApp desconectado (Proprietário/Administrador): consulta a cada minuto. */
export function useWaDownAlerts(): WaDownAlerts | null {
  const { me, can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  const [data, setData] = useState<WaDownAlerts | null>(null);
  useEffect(() => {
    if (!me?.org?.id || !admin) { setData(null); return; }
    let stop = false;
    const check = () => get<WaDownAlerts>('/channels/alertas').then((r) => { if (!stop) setData(r); }).catch(() => undefined);
    check();
    const t = setInterval(check, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [me?.org?.id, admin]);
  return data;
}

/**
 * Aviso no topo do MCKBOT e do MCK Mensagens: "WhatsApp X desconectou desde HH:MM — Reconectar".
 * Some sozinho quando o canal volta. A reconexão é sempre na tela Canais WhatsApp do MCKBOT.
 */
export default function WaDownBanner({ reconnectHref, hideOnPath }: { reconnectHref: string; hideOnPath?: boolean }) {
  const data = useWaDownAlerts();
  if (hideOnPath || !data?.down.length) return null;
  return (
    <div className="alert err row between" role="alert" style={{ margin: '12px 24px 0', borderRadius: 10, gap: 8, flexWrap: 'wrap' }}>
      <span>
        {data.down.length === 1
          ? <><strong>{data.down[0].label}</strong> está <strong>desconectado</strong> desde {fmt(data.down[0].downSince)}: nada é enviado nem recebido por esse número.</>
          : <><strong>{data.down.length} WhatsApps desconectados</strong> ({data.down.map((d) => d.label).join(', ')}): nada é enviado nem recebido por esses números.</>}
      </span>
      <a href={reconnectHref} className="btn sm primary" style={{ color: '#fff', textDecoration: 'none' }}>Reconectar</a>
    </div>
  );
}
