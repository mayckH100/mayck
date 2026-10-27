import { useMemo, useState } from 'react';
import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { useApi, Async, Field, useAction, fmtNum, StatusBadge, Empty } from '../../../ui';
import { put, post, del } from '../../../api';
import { Kpi } from '../Dashboard';
import Clientes from './Clientes';
import Automacoes from './Automacoes';
import { API, ReadOnlyCtx, useReadOnly, OcBadge, fmtDT, hmLocal, ymdLocal, CAT_LABEL, CANAL_LABEL, OC_COLOR } from './shared';

const SUB = [
  { to: '', label: 'Dashboard' }, { to: 'clientes', label: 'Clientes' }, { to: 'agendamentos', label: 'Agendamentos' },
  { to: 'lembretes', label: 'Lembretes' }, { to: 'marketing', label: 'Marketing' }, { to: 'calendario', label: 'Calendário' },
  { to: 'historico', label: 'Histórico' }, { to: 'configuracoes', label: 'Configurações' },
];

export default function AutomacoesModulo({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <ReadOnlyCtx.Provider value={readOnly}>
      <div className="page-head">
        <div><h1>Automações e Cobranças</h1><p className="muted">Clientes, lembretes e marketing com envio programado pelo WhatsApp e por e-mail.</p></div>
      </div>
      {readOnly && <div className="alert info" style={{ marginBottom: 12 }}>Seu perfil é <strong>somente leitura</strong> neste módulo: você consulta tudo, mas não altera.</div>}
      <nav className="tabs" aria-label="Automações">
        {SUB.map((s) => <NavLink key={s.to} to={`/automacoes${s.to ? `/${s.to}` : ''}`} end={!s.to} className={({ isActive }) => `btn ghost sm ${isActive ? 'mm-sub-on' : ''}`}>{s.label}</NavLink>)}
      </nav>
      <Routes>
        <Route index element={<Painel />} />
        <Route path="clientes" element={<Clientes />} />
        <Route path="agendamentos" element={<Automacoes />} />
        <Route path="lembretes" element={<Automacoes categoria="LEMBRETE" />} />
        <Route path="marketing" element={<Automacoes categoria="MARKETING" />} />
        <Route path="calendario" element={<Calendario />} />
        <Route path="historico" element={<Historico />} />
        <Route path="configuracoes" element={<Configuracoes />} />
        <Route path="*" element={<Navigate to="/automacoes" replace />} />
      </Routes>
      <p className="small muted" style={{ marginTop: 18 }}>Boletos, pagamentos, comprovantes, arquivos e relatórios financeiros chegam na próxima fase.</p>
    </ReadOnlyCtx.Provider>
  );
}

function Painel() {
  const d = useApi<any>(`${API}/dashboard`);
  return (
    <Async state={d}>{(m) => (
      <div className="stack">
        <div className="grid g4">
          <Kpi label="Clientes cadastrados" value={fmtNum(m.clientes)} />
          <Kpi label="Mensagens programadas" value={fmtNum(m.programadas)} sub={`${fmtNum(m.pendentes)} vencidas aguardando envio`} />
          <Kpi label="Enviadas hoje" value={fmtNum(m.enviadasHoje)} />
          <Kpi label="Com falha" value={fmtNum(m.falhas)} sub="após todas as tentativas" />
        </div>
        <div className="grid g3">
          <Kpi label="Lembretes ativos" value={fmtNum(m.lembretesAtivos)} />
          <Kpi label="Campanhas de marketing ativas" value={fmtNum(m.marketingAtivas)} />
          <Kpi label="Automações pausadas" value={fmtNum(m.pausadas)} />
        </div>
        <div className="card">
          <h2>Próximos envios</h2>
          {m.proximos.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhum envio programado.</p> : (
            <div className="table-wrap"><table><tbody>{m.proximos.map((o: any) => (
              <tr key={o.id}><td className="small">{fmtDT(o.executarEm)}</td><td>{o.cliente}</td><td className="small">{o.automacao}</td><td className="small">{o.categoria ? CAT_LABEL[o.categoria as 'LEMBRETE'] : ''}</td><td className="small">{CANAL_LABEL[o.canal as 'EMAIL']}</td></tr>
            ))}</tbody></table></div>
          )}
        </div>
      </div>
    )}</Async>
  );
}

function Calendario() {
  const [modo, setModo] = useState<'mes' | 'semana'>('mes');
  const [ref, setRef] = useState(() => new Date());
  const [dia, setDia] = useState<string | null>(null);
  const { de, ate, dias } = useMemo(() => {
    const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    let ini: Date, n: number;
    if (modo === 'semana') { ini = new Date(base); ini.setDate(base.getDate() - base.getDay()); n = 7; }
    else { const first = new Date(base.getFullYear(), base.getMonth(), 1); ini = new Date(first); ini.setDate(1 - first.getDay()); n = 42; }
    const ds = Array.from({ length: n }, (_, i) => { const x = new Date(ini); x.setDate(ini.getDate() + i); return x; });
    const end = new Date(ds[n - 1]); end.setDate(end.getDate() + 1);
    return { de: ini, ate: end, dias: ds };
  }, [ref, modo]);
  const cal = useApi<{ eventos: any[]; timezone: string; truncado: boolean }>(`${API}/calendario?de=${de.toISOString()}&ate=${ate.toISOString()}`);
  const porDia = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const e of cal.data?.eventos ?? []) (m[ymdLocal(new Date(e.agendadoPara), cal.data!.timezone)] ??= []).push(e);
    return m;
  }, [cal.data]);
  const mover = (k: number) => { const x = new Date(ref); if (modo === 'mes') x.setMonth(x.getMonth() + k); else x.setDate(x.getDate() + 7 * k); setRef(x); };
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <button className="btn sm" onClick={() => mover(-1)}>‹</button>
          <strong>{modo === 'mes' ? ref.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : `Semana de ${dias[0].toLocaleDateString('pt-BR')}`}</strong>
          <button className="btn sm" onClick={() => mover(1)}>›</button>
          <button className="btn sm" onClick={() => setRef(new Date())}>Hoje</button>
        </div>
        <div className="row"><button className={`btn sm ${modo === 'mes' ? 'primary' : ''}`} onClick={() => setModo('mes')}>Mês</button><button className={`btn sm ${modo === 'semana' ? 'primary' : ''}`} onClick={() => setModo('semana')}>Semana</button></div>
      </div>
      <Async state={cal}>{() => (
        <div className="mm-cal">
          {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => <div key={d} className="mm-cal-h">{d}</div>)}
          {dias.map((d) => {
            const k = key(d); const evs = porDia[k] ?? [];
            const out = modo === 'mes' && d.getMonth() !== ref.getMonth();
            return (
              <button key={k} className={`mm-cal-d ${out ? 'out' : ''} ${dia === k ? 'sel' : ''}`} style={{ minHeight: modo === 'semana' ? 160 : 78 }} onClick={() => setDia(k)}>
                <span className="n">{d.getDate()}</span>
                {evs.slice(0, modo === 'semana' ? 8 : 3).map((e) => <span key={e.id} className="ev" style={{ borderLeftColor: OC_COLOR[e.status] ?? '#999' }}>{hmLocal(e.agendadoPara, cal.data!.timezone)} {e.cliente}</span>)}
                {evs.length > (modo === 'semana' ? 8 : 3) && <span className="small muted">+{evs.length - (modo === 'semana' ? 8 : 3)}</span>}
              </button>
            );
          })}
        </div>
      )}</Async>
      {dia && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{dia.split('-').reverse().join('/')}</h3>
          {(porDia[dia] ?? []).length === 0 ? <p className="muted small">Nenhum envio neste dia.</p> : (
            <div className="table-wrap"><table><tbody>{porDia[dia].map((e) => (
              <tr key={e.id}><td className="small">{hmLocal(e.agendadoPara, cal.data!.timezone)}</td><td>{e.cliente}</td><td className="small">{e.automacao}{e.automacaoStatus === 'PAUSADA' && <span className="badge amber" style={{ marginLeft: 4 }}>pausada</span>}</td><td className="small">{e.categoria ? CAT_LABEL[e.categoria as 'LEMBRETE'] : ''}</td><td className="small">{CANAL_LABEL[e.canal as 'EMAIL']}</td><td><OcBadge s={e.status} /></td></tr>
            ))}</tbody></table></div>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>Para editar ou cancelar um envio, abra a automação em Agendamentos.</p>
        </div>
      )}
    </div>
  );
}

function Historico() {
  const [f, setF] = useState({ categoria: '', canal: '', status: '', q: '', de: '', ate: '' });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, k === 'de' || k === 'ate' ? new Date(`${v}T${k === 'de' ? '00:00' : '23:59'}`).toISOString() : v);
  const h = useApi<{ items: any[]; total: number; pageSize: number }>(`${API}/historico?${qs}`);
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); setPage(1); };
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Buscar no conteúdo" value={f.q} onChange={set('q')} style={{ maxWidth: 220 }} />
        <select value={f.categoria} onChange={set('categoria')} style={{ width: 'auto' }}><option value="">Categoria</option><option value="LEMBRETE">Lembrete</option><option value="MARKETING">Marketing</option></select>
        <select value={f.canal} onChange={set('canal')} style={{ width: 'auto' }}><option value="">Canal</option><option value="WHATSAPP">WhatsApp</option><option value="EMAIL">E-mail</option></select>
        <select value={f.status} onChange={set('status')} style={{ width: 'auto' }}><option value="">Status</option>{['ENVIADA', 'FALHOU', 'TENTANDO', 'IGNORADA', 'CANCELADA'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select>
        <input type="date" value={f.de} onChange={set('de')} style={{ width: 'auto' }} /> até <input type="date" value={f.ate} onChange={set('ate')} style={{ width: 'auto' }} />
      </div>
      <div className="card table-wrap">
        <Async state={h}>{(d) => d.items.length === 0 ? <Empty title="Nenhum registro">Os envios aparecem aqui assim que são processados.</Empty> : (
          <>
            <table>
              <thead><tr><th>Quando</th><th>Cliente</th><th>Automação</th><th>Canal</th><th>Status</th><th>Mensagem</th></tr></thead>
              <tbody>{d.items.map((x) => (
                <tr key={x.id}>
                  <td className="small">{fmtDT(x.enviadoEm ?? x.updatedAt)}<div className="muted">prog.: {fmtDT(x.agendadoPara)}</div></td>
                  <td>{x.cliente}</td><td className="small">{x.automacao}<div className="muted">{CAT_LABEL[x.categoria as 'LEMBRETE']}</div></td>
                  <td className="small">{CANAL_LABEL[x.canal as 'EMAIL']}</td>
                  <td><OcBadge s={x.status} /><div className="small muted">{x.tentativas} tentativa(s)</div>{x.erro && <div className="small" style={{ color: 'var(--danger)' }}>{x.erro}</div>}{x.provedorId && <div className="small muted" title={x.provedorId}>id: {String(x.provedorId).slice(0, 18)}…</div>}</td>
                  <td className="small" style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>{x.assunto && <strong>{x.assunto}<br /></strong>}{x.conteudo}</td>
                </tr>
              ))}</tbody>
            </table>
            <div className="row between small muted" style={{ marginTop: 8 }}>
              <span>{fmtNum(d.total)} registro(s)</span>
              <span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button> Página {page}<button className="btn sm" disabled={page * d.pageSize >= d.total} onClick={() => setPage(page + 1)}>›</button></span>
            </div>
          </>
        )}</Async>
      </div>
    </div>
  );
}

function Configuracoes() {
  const ro = useReadOnly();
  const cfg = useApi<any>(`${API}/config`);
  const integ = useApi<any>(`${API}/integracoes`);
  const modelos = useApi<any[]>(`${API}/modelos`);
  const { busy, run } = useAction();
  const [smtp, setSmtp] = useState<any>(null);
  const [novo, setNovo] = useState({ categoria: 'LEMBRETE', nome: '', assunto: '', corpo: '' });
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h2>Regras de envio</h2>
        <Async state={cfg}>{(c) => (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            run(async () => {
              cfg.setData(await put(`${API}/config`, {
                timezone: fd.get('timezone'), janelaInicio: fd.get('janelaInicio'), janelaFim: fd.get('janelaFim'),
                limiteDiario: Number(fd.get('limiteDiario')), maxTentativas: Number(fd.get('maxTentativas')), backoffSeg: Number(fd.get('backoffSeg')),
              }));
            }, 'Configurações salvas');
          }}>
            <fieldset disabled={ro} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
              <Field label="Fuso horário"><input name="timezone" defaultValue={c.timezone} /></Field>
              <div className="grid g2">
                <Field label="Enviar a partir de"><input type="time" name="janelaInicio" defaultValue={c.janelaInicio} /></Field>
                <Field label="Até" hint="Fora da janela, o envio espera a próxima abertura"><input type="time" name="janelaFim" defaultValue={c.janelaFim} /></Field>
                <Field label="Limite de envios por dia"><input type="number" name="limiteDiario" min={1} defaultValue={c.limiteDiario} /></Field>
                <Field label="Máximo de tentativas"><input type="number" name="maxTentativas" min={1} max={10} defaultValue={c.maxTentativas} /></Field>
                <Field label="Espera entre tentativas (s)" hint="dobra a cada nova tentativa"><input type="number" name="backoffSeg" min={10} defaultValue={c.backoffSeg} /></Field>
              </div>
              {!ro && <button className="btn primary" disabled={busy}>Salvar</button>}
            </fieldset>
          </form>
        )}</Async>
      </div>
      <div className="card">
        <h2>Integrações</h2>
        <Async state={integ}>{(i) => (
          <div className="stack">
            <div><strong className="small">WhatsApp</strong>
              {i.whatsapp.length === 0 ? <div className="small muted">Nenhum canal cadastrado. Conecte um número no MCKBOT, em Canais WhatsApp.</div>
                : i.whatsapp.map((w: any) => <div key={w.id} className="row small">{w.nome} {w.telefone && <span className="muted">{w.telefone}</span>} <span className="muted">({w.provedor === 'whatsapp_qr' ? 'QR code' : 'API oficial'})</span> {w.status === 'DISCONNECTED' ? <span className="badge red">Desconectado</span> : <StatusBadge status={w.status} />}{w.erro && <span className="muted">— {w.erro}</span>}</div>)}
            </div>
            <div><strong className="small">E-mail (SMTP)</strong>
              <div className="row small">{i.email.configurado ? <span className="badge green">Configurado</span> : <span className="badge red">Não configurado</span>} {i.email.remetente && <span className="muted">{i.email.remetente}</span>}
                {i.email.configurado && !ro && <button className="btn sm" disabled={busy} onClick={() => run(async () => setSmtp(await post(`${API}/integracoes/email/verificar`)))}>Testar conexão</button>}
              </div>
              {smtp && <div className={`alert ${smtp.ok ? 'ok' : 'err'} small`}>{smtp.ok ? 'Conexão SMTP autenticada com sucesso (nenhum e-mail foi enviado).' : `Falha: ${smtp.error}`}</div>}
            </div>
          </div>
        )}</Async>
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>Modelos de mensagem</h2>
        <Async state={modelos}>{(ms) => (
          <div className="stack">
            {ms.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nenhum modelo salvo.</p>}
            {ms.map((m) => (
              <div key={m.id} className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                <div className="small"><strong>{m.nome}</strong> <span className="badge">{CAT_LABEL[m.categoria as 'LEMBRETE']}</span><div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{m.corpo}</div></div>
                {!ro && <button className="btn sm danger" onClick={() => run(async () => { await del(`${API}/modelos/${m.id}`); modelos.reload(); }, 'Modelo excluído')}>Excluir</button>}
              </div>
            ))}
            {!ro && (
              <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <div className="grid g3">
                  <select value={novo.categoria} onChange={(e) => setNovo({ ...novo, categoria: e.target.value })}><option value="LEMBRETE">Lembrete</option><option value="MARKETING">Marketing</option></select>
                  <input placeholder="Nome do modelo" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
                  <input placeholder="Assunto do e-mail (opcional)" value={novo.assunto} onChange={(e) => setNovo({ ...novo, assunto: e.target.value })} />
                </div>
                <textarea rows={3} placeholder="Olá, {{primeiro_nome}}! …" value={novo.corpo} onChange={(e) => setNovo({ ...novo, corpo: e.target.value })} />
                <div><button className="btn primary sm" disabled={busy || !novo.nome.trim() || !novo.corpo.trim()} onClick={() => run(async () => { await post(`${API}/modelos`, { ...novo, assunto: novo.assunto || null }); setNovo({ ...novo, nome: '', assunto: '', corpo: '' }); modelos.reload(); }, 'Modelo salvo')}>Salvar modelo</button></div>
              </div>
            )}
          </div>
        )}</Async>
      </div>
    </div>
  );
}
