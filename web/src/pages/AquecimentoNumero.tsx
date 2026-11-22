import { useEffect, useState } from 'react';
import { post, put, del } from '../api';
import { useApi, useAction, Modal, Field, fmtDate } from '../ui';

/**
 * v1.45.0 — Aquecimento ATIVO do número (WhatsApp por QR), no cartão de cada número em Canais.
 * Bloco à vista com status (dia X de N, nível, mensagens de hoje), botão "🔥 Aquecer número" e aviso para número novo.
 */

const HONESTO = 'O aquecimento reduz o risco de bloqueio, mas não garante que o WhatsApp não bloqueie o número. Usar o número normalmente ajuda muito: coloque foto, nome e recado no perfil e converse com contatos reais.';

export function AquecimentoNumero({ c, admin }: { c: any; admin: boolean }) {
  const st = useApi<any>(`/channels/${c.id}/aquecimento`, [c.id, c.status]);
  const [open, setOpen] = useState(false);
  const s = st.data;
  useEffect(() => { const t = setInterval(() => st.reload(), 60_000); return () => clearInterval(t); }, [c.id]);
  if (!s) return st.error ? <div className="alert warn small">Não foi possível carregar o aquecimento do número.</div> : null;
  const ligado = s.config.enabled;
  return (
    <div className="stack small" style={{ gap: 6, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 8 }}>
      {s.avisoNumeroNovo && (
        <div className="alert warn small" role="status">
          <strong>Número novo ({s.idadeDias === 0 ? 'adicionado hoje' : `${s.idadeDias} dia${s.idadeDias > 1 ? 's' : ''}`}):</strong> ligue o aquecimento ativo para reduzir o risco de bloqueio nos primeiros 14 dias.
        </div>
      )}
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>🔥 Aquecimento do número</strong>
        <span className={`badge ${ligado ? (s.rodando ? 'green' : 'amber') : ''}`}>
          {!ligado ? 'Desligado' : s.motivo === 'concluido' ? 'Concluído' : s.rodando ? 'Aquecendo' : 'Pausado'}
        </span>
      </div>
      {ligado && s.dia && s.motivo !== 'concluido' && (
        <div className="grid g4" style={{ gap: 8 }}>
          <div className="stat" title="Dia do aquecimento"><div className="l">Dia</div><div className="v" style={{ fontSize: 18 }}>{s.dia}<span className="muted" style={{ fontSize: 12 }}> de {s.dias}</span></div></div>
          <div className="stat" title="O volume de mensagens sobe dia a dia"><div className="l">Nível</div><div className="v" style={{ fontSize: 18 }}>{s.nivel ?? '—'}</div></div>
          <div className="stat" title="Mensagens de aquecimento enviadas hoje por este número / meta de hoje"><div className="l">Hoje</div><div className="v" style={{ fontSize: 18 }}>{s.hoje.enviadas}<span className="muted" style={{ fontSize: 12 }}> / {s.metaHoje ?? '—'}</span></div></div>
          <div className="stat" title="Mensagens de aquecimento recebidas hoje"><div className="l">Recebidas</div><div className="v" style={{ fontSize: 18 }}>{s.hoje.recebidas}</div></div>
        </div>
      )}
      {ligado && s.motivoTexto && <div className="muted">{s.motivoTexto}</div>}
      {ligado && s.proximaEm && s.rodando && <div className="muted">Próxima conversa por volta de {fmtDate(s.proximaEm)} · {s.hoje.conversas} conversa(s) hoje.</div>}
      {!ligado && <div className="muted">Conversas automáticas e espaçadas entre os seus próprios números conectados, com volume que cresce por dia. Nunca envia para clientes.</div>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className={`btn sm ${ligado ? '' : 'primary'}`} onClick={() => setOpen(true)}>{ligado ? '🔥 Aquecimento: ajustar' : '🔥 Aquecer número'}</button>
      </div>
      {open && <AquecimentoModal c={c} s={s} admin={admin} onClose={() => setOpen(false)} onSaved={st.reload} />}
    </div>
  );
}

function AquecimentoModal({ c, s, admin, onClose, onSaved }: { c: any; s: any; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(() => ({
    enabled: s.config.enabled, days: s.config.days, startHour: s.config.startHour, endHour: s.config.endHour,
    peers: s.config.peerChannelIds?.length ? s.config.peerChannelIds : s.pares.map((p: any) => p.id),
    allowAsPeer: s.config.allowAsPeer, useAi: s.config.useAi, useExtras: s.config.useExtras,
  }));
  const { busy, run } = useAction();
  const save = (extra: Record<string, unknown> = {}) => {
    const todos = s.pares.length > 0 && f.peers.length === s.pares.length;
    return run(() => put(`/channels/${c.id}/aquecimento`, {
      enabled: !!f.enabled, days: Number(f.days), startHour: Number(f.startHour), endHour: Number(f.endHour),
      peerChannelIds: todos ? [] : f.peers, allowAsPeer: !!f.allowAsPeer, useAi: !!f.useAi, useExtras: !!f.useExtras, ...extra,
    }), f.enabled ? 'Aquecimento do número salvo' : 'Aquecimento desligado').then((r) => { if (r) { onSaved(); onClose(); } });
  };
  const conectadosPares = s.pares.filter((p: any) => p.conectado).length;
  return (
    <Modal title={`🔥 Aquecer número — ${c.label ?? c.name}`} onClose={onClose}>
      <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="alert small">{HONESTO}</div>
        <p className="small muted" style={{ margin: 0 }}>
          Como funciona: este número troca mensagens casuais com os <strong>seus outros números conectados</strong> (e, se quiser, com até 5 números seus cadastrados abaixo), com ida e volta, “digitando…”, leitura e às vezes uma reação.
          Começa com 10 a 15 mensagens no 1º dia e sobe até 60 a 80 por dia no fim, só dentro do horário escolhido, com intervalos longos e aleatórios. Essas mensagens não aparecem no Inbox, não acionam a IA nem os fluxos e não entram nos relatórios.
          Se o número cair para <strong>Risco</strong> ou desconectar, o aquecimento pausa sozinho.
        </p>
        {s.pares.length === 0 && <div className="alert warn small">Você tem só este número por QR. Conecte outro número da empresa em Canais ou cadastre um número seu abaixo para o aquecimento ter com quem conversar.</div>}
        {s.pares.length > 0 && conectadosPares === 0 && <div className="alert warn small">Nenhum dos seus outros números está conectado agora. O aquecimento espera um deles conectar.</div>}
        <fieldset disabled={!admin || busy} className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }} title={admin ? undefined : 'Só Proprietário ou Administrador pode alterar'}>
          <label className="row"><input type="checkbox" checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> <strong>Ligar o aquecimento ativo neste número</strong></label>
          <div className="grid g2" style={{ gap: 8 }}>
            <Field label="Duração (dias)" hint="Padrão 14 dias"><input type="number" min={3} max={30} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
            <div className="grid g2" style={{ gap: 8 }}>
              <Field label="Das (hora)" hint="Brasília"><input type="number" min={6} max={22} value={f.startHour} onChange={(e) => setF({ ...f, startHour: e.target.value })} /></Field>
              <Field label="Até (hora)" hint="Padrão 8h às 21h"><input type="number" min={7} max={23} value={f.endHour} onChange={(e) => setF({ ...f, endHour: e.target.value })} /></Field>
            </div>
          </div>
          {s.pares.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <strong className="small">Conversar com estes números da empresa</strong>
              {s.pares.map((p: any) => (
                <label key={p.id} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" checked={f.peers.includes(p.id)} onChange={(e) => setF({ ...f, peers: e.target.checked ? [...f.peers, p.id] : f.peers.filter((x: string) => x !== p.id) })} />
                  {p.nome}{p.numero ? ` · ${p.numero}` : ''} <span className={`badge ${p.conectado ? 'green' : ''}`}>{p.conectado ? 'conectado' : 'desconectado'}</span>
                </label>
              ))}
            </div>
          )}
          <label className="row small"><input type="checkbox" checked={!!f.allowAsPeer} onChange={(e) => setF({ ...f, allowAsPeer: e.target.checked })} /> Este número também pode responder e ajudar a aquecer os outros números da empresa</label>
          <label className="row small"><input type="checkbox" checked={!!f.useAi} onChange={(e) => setF({ ...f, useAi: e.target.checked })} /> Variar as frases com a IA da empresa (usa pouca cota, nunca a do atendimento; sem IA usa frases prontas)</label>
          <label className="row small"><input type="checkbox" checked={!!f.useExtras} onChange={(e) => setF({ ...f, useExtras: e.target.checked })} /> Incluir os números próprios extras cadastrados abaixo</label>
          {admin && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm primary">Salvar</button>
              {s.config.enabled && <button type="button" className="btn sm" onClick={() => { if (confirm('Recomeçar o aquecimento? A contagem volta para o dia 1 hoje.')) save({ restart: true }); }}>Recomeçar do dia 1</button>}
            </div>
          )}
        </fieldset>
      </form>
      <NumerosExtras admin={admin} />
    </Modal>
  );
}

/** Até 5 números próprios extras (ex.: celular pessoal) para o aquecimento. Só números que a empresa declara serem dela. */
function NumerosExtras({ admin }: { admin: boolean }) {
  const st = useApi<any[]>('/channels/aquecimento/extras');
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [ok, setOk] = useState(false);
  const { busy, run } = useAction();
  const list = st.data ?? [];
  const add = () => run(() => post('/channels/aquecimento/extras', { phone, label: label || null, confirm: ok }), 'Número próprio cadastrado').then((r) => { if (r) { setPhone(''); setLabel(''); setOk(false); st.reload(); } });
  return (
    <div className="stack small" style={{ gap: 6, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 8 }}>
      <strong>Números próprios extras (opcional, até 5)</strong>
      <p className="muted" style={{ margin: 0 }}>Ex.: seu celular pessoal. O aquecimento manda de vez em quando uma mensagem casual para eles (as respostas que você der também ficam fora do Inbox por algumas horas). Nunca cadastre número de cliente ou de outra pessoa sem autorização.</p>
      {list.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {list.map((e) => (
            <li key={e.id}>+{e.phone}{e.label ? ` · ${e.label}` : ''} {admin && <button type="button" className="linklike small" disabled={busy} onClick={() => { if (confirm('Remover este número do aquecimento?')) run(() => del(`/channels/aquecimento/extras/${e.id}`), 'Número removido').then(() => st.reload()); }}>remover</button>}</li>
          ))}
        </ul>
      )}
      {admin && list.length < 5 && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="grid g2" style={{ gap: 8 }}>
            <Field label="Número com DDD" hint="Ex.: 11 99999-0000"><input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Apelido (opcional)" hint="Ex.: Meu celular"><input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></Field>
          </div>
          <label className="row small" style={{ alignItems: 'flex-start', gap: 6 }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> <span>Confirmo que este número é da minha empresa (meu ou de alguém da equipe, com autorização) e não é de cliente.</span></label>
          <div><button type="button" className="btn sm" disabled={busy || !ok || phone.replace(/\D/g, '').length < 10} onClick={add}>Cadastrar número</button></div>
        </div>
      )}
    </div>
  );
}

export { HONESTO as TEXTO_AQUECIMENTO_HONESTO };
