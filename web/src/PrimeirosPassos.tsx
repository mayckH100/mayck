import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './auth';
import { useApi } from './ui';

/**
 * Primeiros passos (conta nova): checklist no Dashboard com o estado real de cada passo.
 * Some quando os 3 estão feitos ou quando o usuário dispensa (guardado neste navegador, por organização).
 */
export const primeirosPassosKey = (orgId: string) => `mck:primeiros-passos:dispensado:${orgId}`;
const isDismissed = (orgId: string) => { try { return localStorage.getItem(primeirosPassosKey(orgId)) === '1'; } catch { return false; } };
const dismiss = (orgId: string) => { try { localStorage.setItem(primeirosPassosKey(orgId), '1'); } catch { /* modo privado: some só agora */ } };

interface Passos { steps: { whatsapp: boolean; instrucoes: boolean; teste: boolean }; placeholders: number; done: boolean }

export default function PrimeirosPassos() {
  const { me, can } = useAuth();
  const orgId = me?.org?.id ?? '';
  const admin = can('OWNER', 'ADMIN');
  const [hidden, setHidden] = useState(() => !orgId || isDismissed(orgId));
  const state = useApi<Passos>(admin && !hidden ? '/dashboard/primeiros-passos' : null);
  const d = state.data;
  if (!admin || hidden || !d || d.done) return null;
  const feitos = [d.steps.whatsapp, d.steps.instrucoes, d.steps.teste].filter(Boolean).length;
  const Item = ({ ok, n, title, children }: { ok: boolean; n: number; title: string; children: ReactNode }) => (
    <li className="row" style={{ gap: 12, alignItems: 'flex-start', padding: '10px 0', borderTop: n > 1 ? '1px solid var(--border, #e5e5e5)' : undefined }}>
      <span aria-label={ok ? 'feito' : `passo ${n}`} className={`badge ${ok ? 'green' : ''}`} style={{ minWidth: 28, justifyContent: 'center', textAlign: 'center' }}>{ok ? '✓' : n}</span>
      <div style={{ flex: 1 }}>
        <strong style={{ textDecoration: ok ? 'line-through' : undefined, opacity: ok ? 0.7 : 1 }}>{title}</strong>
        {!ok && <div className="small muted" style={{ marginTop: 4 }}>{children}</div>}
      </div>
    </li>
  );
  return (
    <section className="card stack" aria-label="Primeiros passos" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Primeiros passos</h2>
          <p className="small muted" style={{ margin: 0 }}>{feitos} de 3 concluídos. Em poucos minutos a IA já atende seus clientes no WhatsApp.</p>
        </div>
        <button type="button" className="btn sm ghost" onClick={() => { dismiss(orgId); setHidden(true); }}>Dispensar</button>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <Item ok={d.steps.whatsapp} n={1} title="Conectar o WhatsApp">
          Leia o QR code com o WhatsApp da empresa (ou use a API oficial). <div style={{ marginTop: 6 }}><Link className="btn sm primary" to="/canais">Conectar WhatsApp</Link></div>
        </Item>
        <Item ok={d.steps.instrucoes} n={2} title="Preencher as Instruções da IA">
          Conte quem é a empresa, o que vende, preços, horários e endereço. Comece por um modelo pronto do seu segmento.
          {d.placeholders > 0 && <> Ainda há <strong>{d.placeholders}</strong> campo(s) [preencha] para completar.</>}
          <div style={{ marginTop: 6 }}><Link className="btn sm primary" to="/ia?modelo=1">Usar modelo do meu segmento</Link></div>
        </Item>
        <Item ok={d.steps.teste} n={3} title="Testar uma conversa">
          Faça uma pergunta como se fosse um cliente e veja a resposta da IA (nada é enviado no WhatsApp). <div style={{ marginTop: 6 }}><Link className="btn sm primary" to="/ia?aba=testar">Testar a IA</Link></div>
        </Item>
      </ol>
    </section>
  );
}
