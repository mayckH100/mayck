/**
 * v1.46.0 — Cartão "Link de agendamento" na Agenda: o cliente escolhe serviço, dia e horário livre numa página pública
 * (/agendar/:slug). Aqui o dono liga a página, cadastra os serviços, copia o link e baixa o QR code.
 */
import { useState } from 'react';
import { del, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { useApi, useAction, useToast, Modal, Field, copy, Spinner } from '../ui';

const reaisParaCentavos = (v: string): number | null => {
  const t = v.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const centavosParaReais = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export function AgendaLinkCard() {
  const { can } = useAuth();
  const admin = can('OWNER', 'ADMIN');
  const st = useApi<any>('/agenda/link');
  const [cfg, setCfg] = useState(false);
  const [qr, setQr] = useState(false);
  const toast = useToast();
  const { busy, run } = useAction();
  const d = st.data;
  return (
    <div className="card stack" aria-label="Link de agendamento">
      <div className="row between">
        <strong>🔗 Link de agendamento</strong>
        {d && <span className={`badge ${d.enabled ? 'green' : ''}`}>{d.enabled ? 'No ar' : 'Desligado'}</span>}
      </div>
      {!d ? (st.error ? <span className="small muted">{st.error}</span> : <span className="small muted"><Spinner /> Carregando…</span>) : (
        <>
          <p className="small muted" style={{ margin: 0 }}>Seu cliente escolhe o serviço, o dia e um horário livre, informa nome e WhatsApp e recebe a confirmação no WhatsApp. O agendamento entra na Agenda, no Inbox e no Kanban.</p>
          {d.enabled ? (
            <>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input readOnly value={d.url} aria-label="Link de agendamento" onFocus={(e) => e.currentTarget.select()} />
                <button className="btn sm primary" onClick={() => copy(d.url, toast)}>Copiar link</button>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => setQr(true)}>QR code</button>
                <a className="btn sm" href={d.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Abrir página</a>
                {admin && <button className="btn sm" onClick={() => setCfg(true)}>Configurar</button>}
              </div>
            </>
          ) : admin ? (
            <div className="row">
              <button className="btn sm primary" onClick={() => setCfg(true)}>{d.services.length ? 'Configurar e ligar' : 'Criar meu link'}</button>
              {d.services.some((s: any) => s.active) && <button className="btn sm" disabled={busy} onClick={() => run(() => put('/agenda/link', { enabled: true }), 'Página de agendamento no ar').then(st.reload)}>{busy ? 'Ligando…' : 'Ligar agora'}</button>}
            </div>
          ) : <span className="small muted">Peça a um administrador para ligar a página.</span>}
        </>
      )}
      {qr && d && (
        <Modal title="QR code do agendamento" onClose={() => setQr(false)}>
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <img src={d.qr} alt="QR code do link de agendamento" width={240} height={240} />
            <span className="small muted">Imprima no balcão, no cardápio ou no cartão de visita. A câmera do celular abre a página.</span>
            <a className="btn primary" href={d.qr} download={`agendamento-${d.slug}.png`}>Baixar imagem</a>
          </div>
        </Modal>
      )}
      {cfg && d && <ConfigModal d={d} onClose={() => setCfg(false)} onChange={st.reload} />}
    </div>
  );
}

function ConfigModal({ d, onClose, onChange }: { d: any; onClose: () => void; onChange: () => void }) {
  const [f, setF] = useState({ slug: d.slug, title: d.title, intro: d.intro, maxDaysAhead: d.maxDaysAhead, enabled: d.enabled });
  const [novo, setNovo] = useState({ name: '', durationMin: 30, preco: '', description: '' });
  const [editando, setEditando] = useState<string | null>(null);
  const [ed, setEd] = useState<any>(null);
  const { busy, run } = useAction();
  const ativos = d.services.filter((s: any) => s.active).length;
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const exp = d.expediente;
  const salvar = () => run(() => put('/agenda/link', { ...f, maxDaysAhead: Number(f.maxDaysAhead) }), f.enabled ? 'Página salva e no ar' : 'Página salva').then((r) => { if (r) { onChange(); onClose(); } });
  return (
    <Modal title="Link de agendamento" onClose={onClose}>
      <div className="stack">
        <div className="small muted">Horários livres seguem a Agenda: {exp.workDays.map((n: number) => dias[n]).join(', ')}, das {exp.workStart} às {exp.workEnd}, com {exp.minNoticeMin} min de antecedência (mude em Agenda › Configurações). Compromissos já marcados e o Google Agenda conectado ficam bloqueados.</div>
        <strong>Serviços</strong>
        {d.services.length === 0 && <span className="small muted">Cadastre pelo menos um serviço (ex.: Corte de cabelo, 30 min, R$ 40).</span>}
        {d.services.map((s: any) => editando === s.id ? (
          <form key={s.id} className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); run(() => patch(`/agenda/link/servicos/${s.id}`, { name: ed.name, durationMin: Number(ed.durationMin), priceCents: reaisParaCentavos(ed.preco), description: ed.description }), 'Serviço salvo').then((r) => { if (r) { setEditando(null); onChange(); } }); }}>
            <input aria-label="Nome do serviço" required maxLength={80} value={ed.name} onChange={(e) => setEd({ ...ed, name: e.target.value })} />
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input aria-label="Duração em minutos" type="number" min={5} max={480} step={5} value={ed.durationMin} onChange={(e) => setEd({ ...ed, durationMin: e.target.value })} />
              <input aria-label="Preço" placeholder="Preço (opcional)" value={ed.preco} onChange={(e) => setEd({ ...ed, preco: e.target.value })} inputMode="decimal" />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn sm" onClick={() => setEditando(null)}>Voltar</button><button className="btn sm primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button></div>
          </form>
        ) : (
          <div key={s.id} className="row between" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
            <span style={{ opacity: s.active ? 1 : 0.55 }}><strong>{s.name}</strong> <span className="small muted">· {s.durationMin} min{s.price ? ` · ${s.price}` : ''}{s.active ? '' : ' · pausado'}</span></span>
            <span className="row">
              <button className="btn sm ghost" onClick={() => { setEditando(s.id); setEd({ name: s.name, durationMin: s.durationMin, preco: centavosParaReais(s.priceCents), description: s.description }); }}>Editar</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => run(() => patch(`/agenda/link/servicos/${s.id}`, { active: !s.active }), s.active ? 'Serviço pausado' : 'Serviço ativo').then(onChange)}>{s.active ? 'Pausar' : 'Ativar'}</button>
              <button className="btn sm ghost" disabled={busy} aria-label={`Excluir ${s.name}`} onClick={() => run(() => del(`/agenda/link/servicos/${s.id}`), 'Serviço excluído').then(onChange)}>✕</button>
            </span>
          </div>
        ))}
        <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); run(() => post('/agenda/link/servicos', { name: novo.name, durationMin: Number(novo.durationMin), priceCents: reaisParaCentavos(novo.preco), description: novo.description }), 'Serviço adicionado').then((r) => { if (r) { setNovo({ name: '', durationMin: 30, preco: '', description: '' }); onChange(); } }); }}>
          <input aria-label="Novo serviço" placeholder="Novo serviço (ex.: Banho pequeno porte)" required minLength={2} maxLength={80} value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} />
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <label className="small" style={{ flex: 1 }}>Duração (min)<input type="number" min={5} max={480} step={5} value={novo.durationMin} onChange={(e) => setNovo({ ...novo, durationMin: Number(e.target.value) })} /></label>
            <label className="small" style={{ flex: 1 }}>Preço (opcional)<input placeholder="40,00" value={novo.preco} onChange={(e) => setNovo({ ...novo, preco: e.target.value })} inputMode="decimal" /></label>
          </div>
          <button className="btn sm" disabled={busy}>+ Adicionar serviço</button>
        </form>
        <strong>Página</strong>
        <Field label="Endereço do link" hint={`${d.url.replace(/\/agendar\/.*$/, '')}/agendar/${f.slug || '…'}`}><input value={f.slug} maxLength={40} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></Field>
        <Field label="Título da página"><input value={f.title} maxLength={100} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Mensagem de apresentação (opcional)"><textarea rows={2} maxLength={500} value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} placeholder="Ex.: Escolha o serviço e o melhor horário. Chegue 5 minutos antes." /></Field>
        <Field label="Até quantos dias à frente o cliente pode marcar"><input type="number" min={1} max={90} value={f.maxDaysAhead} onChange={(e) => setF({ ...f, maxDaysAhead: Number(e.target.value) })} /></Field>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.enabled} disabled={!ativos} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Página no ar{!ativos ? ' (cadastre um serviço ativo primeiro)' : ''}</label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Fechar</button>
          <button type="button" className="btn primary" disabled={busy} onClick={salvar}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </div>
    </Modal>
  );
}
