import { useEffect, useState } from 'react';
import { useApi, Async, Modal, Field, useAction, Empty } from '../../../ui';
import { post, patch, get } from '../../../api';
import { API, useReadOnly, AutoBadge, OcBadge, BolBadge, fmtDT, fmtYmd, brl, hmLocal, ymdLocal, CAT_LABEL, CANAL_LABEL, type Automacao, type Categoria, type Canal, type Cliente, type Ocorrencia, type AnexoView, type Boleto, type Arquivo } from './shared';
import { SequenciaForm, UploadButton, ArquivoLink } from './Cobrancas';

const TIPOS: { v: string; l: string }[] = [
  { v: 'UNICO', l: 'Envio único' }, { v: 'DIARIO', l: 'Todos os dias (um ou mais horários)' }, { v: 'SEMANAL', l: 'Dias da semana' },
  { v: 'MENSAL', l: 'Dias do mês' }, { v: 'DATAS', l: 'Datas específicas (cada uma com seu horário)' }, { v: 'ANUAL', l: 'Repetição anual' },
  { v: 'INTERVALO', l: 'Intervalo personalizado' },
];
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export default function Automacoes({ categoria }: { categoria?: Categoria }) {
  const ro = useReadOnly();
  const list = useApi<Automacao[]>(`${API}/automacoes${categoria ? `?categoria=${categoria}` : ''}`);
  const [edit, setEdit] = useState<Automacao | 'nova' | null>(null);
  const [ver, setVer] = useState<string | null>(null);
  const [seq, setSeq] = useState(false);
  const { busy, run } = useAction();
  const acao = (a: Automacao, op: string, msg: string) => run(async () => { await post(`${API}/automacoes/${a.id}/${op}`); list.reload(); }, msg);
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted" style={{ margin: 0 }}>
          {categoria === 'LEMBRETE' ? 'Avisos e acompanhamentos (renovação, prazos, reuniões). Independentes do módulo financeiro.'
            : categoria === 'MARKETING' ? 'Campanhas comerciais. Só recebem clientes com consentimento e sem pedido de descadastro.'
              : categoria === 'COBRANCA' ? 'Sequências de cobrança: cada mensagem leva o seu boleto, na ordem definida. Boleto pago, cancelado ou em análise não é cobrado; reenvios só para pendentes e vencidos.'
                : 'Todos os agendamentos de mensagens (lembretes, marketing e cobranças).'}
        </p>
        {!ro && <div className="row">
          {categoria === 'COBRANCA' && <button className="btn primary" onClick={() => setSeq(true)}>+ Nova sequência a partir dos boletos</button>}
          <button className={`btn ${categoria === 'COBRANCA' ? '' : 'primary'}`} onClick={() => setEdit('nova')}>+ Novo {categoria === 'MARKETING' ? 'envio de marketing' : categoria === 'LEMBRETE' ? 'lembrete' : categoria === 'COBRANCA' ? 'agendamento de cobrança (avançado)' : 'agendamento'}</button>
        </div>}
      </div>
      <div className="card table-wrap">
        <Async state={list}>{(items) => items.length === 0 ? <Empty title="Nada agendado ainda">Crie um agendamento para começar.</Empty> : (
          <table>
            <thead><tr><th>Nome</th><th>Frequência</th><th>Canais</th><th>Status</th><th>Próximo envio</th><th>Enviadas / falhas</th><th /></tr></thead>
            <tbody>{items.map((a) => (
              <tr key={a.id}>
                <td><button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setVer(a.id)}><strong>{a.nome}</strong></button><div className="small muted">{CAT_LABEL[a.categoria]} · {a.clienteIds.length} cliente(s)</div></td>
                <td className="small">{a.descricao}</td>
                <td className="small">{a.canais.map((c) => CANAL_LABEL[c]).join(' + ')}</td>
                <td><AutoBadge s={a.status} /></td>
                <td className="small">{fmtDT(a.proximoEnvio, a.timezone)}</td>
                <td className="small">{a.ocorrencias.ENVIADA ?? 0} / {a.ocorrencias.FALHOU ?? 0}</td>
                <td>{!ro && (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    {a.status === 'RASCUNHO' && <button className="btn sm primary" disabled={busy} onClick={() => acao(a, 'ativar', 'Automação ativada')}>Ativar</button>}
                    {a.status === 'ATIVA' && <button className="btn sm" disabled={busy} onClick={() => acao(a, 'pausar', 'Automação pausada')}>Pausar</button>}
                    {a.status === 'PAUSADA' && <button className="btn sm" disabled={busy} onClick={() => acao(a, 'retomar', 'Automação retomada')}>Retomar</button>}
                    {['RASCUNHO', 'ATIVA', 'PAUSADA'].includes(a.status) && <button className="btn sm" onClick={() => setEdit(a)}>Editar</button>}
                    <button className="btn sm" disabled={busy} onClick={() => acao(a, 'duplicar', 'Cópia criada como rascunho')}>Duplicar</button>
                    {a.status !== 'CANCELADA' && a.status !== 'CONCLUIDA' && <button className="btn sm danger" disabled={busy} onClick={() => confirm('Cancelar a automação e todos os envios pendentes?') && acao(a, 'cancelar', 'Automação cancelada')}>Cancelar</button>}
                  </div>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}</Async>
      </div>
      {edit && <Editor automacao={edit === 'nova' ? null : edit} categoria={categoria} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {ver && <Detalhe id={ver} onClose={() => { setVer(null); list.reload(); }} />}
      {seq && <SequenciaForm onClose={() => setSeq(false)} onSaved={() => { setSeq(false); list.reload(); }} />}
    </div>
  );
}

const f0Categoria = (a: Automacao | null, c?: Categoria) => a?.categoria ?? c ?? 'LEMBRETE';

function Editor({ automacao, categoria, onClose, onSaved }: { automacao: Automacao | null; categoria?: Categoria; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const hoje = ymdLocal(new Date());
  const [f, setF] = useState(() => ({
    nome: automacao?.nome ?? '', categoria: (automacao?.categoria ?? categoria ?? 'LEMBRETE') as Categoria, canais: automacao?.canais ?? (['WHATSAPP'] as Canal[]),
    channelId: automacao?.channelId ?? '', assunto: automacao?.assunto ?? '', mensagem: automacao?.mensagem ?? '', clienteIds: automacao?.clienteIds ?? ([] as string[]),
    inicio: automacao ? ymdLocal(new Date(automacao.inicio), automacao.timezone) : hoje, fim: automacao?.fim ? ymdLocal(new Date(automacao.fim), automacao.timezone) : '',
    maxEnvios: automacao?.maxEnvios ? String(automacao.maxEnvios) : '',
  }));
  const [regra, setRegra] = useState<any>(automacao?.regra ?? { tipo: 'UNICO', data: hoje, horario: '09:00' });
  const [anexos, setAnexos] = useState<AnexoView[]>(automacao?.anexos ?? []);
  const [reenvio, setReenvio] = useState<any>(automacao?.reenvio ?? (f0Categoria(automacao, categoria) === 'COBRANCA' ? { offsets: [0, 1, 3, 7], horario: '10:00', maxPorBoleto: 3, mensagem: '' } : null));
  const [arqNomes, setArqNomes] = useState<Record<string, string>>({});
  const [busca, setBusca] = useState('');
  const clientes = useApi<{ items: Cliente[] }>(`${API}/clientes?pageSize=500${busca ? `&q=${encodeURIComponent(busca)}` : ''}`);
  const modelos = useApi<any[]>(`${API}/modelos?categoria=${f.categoria}`);
  const vars = useApi<{ disponiveis: { chave: string; rotulo: string }[]; boleto: { chave: string; rotulo: string }[] }>(`${API}/variaveis`);
  const channels = useApi<any[]>('/channels');
  const [previa, setPrevia] = useState<any>(null);
  const [horarios, setHorarios] = useState<any>(null);
  const [prevCli, setPrevCli] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      post(`${API}/regra/previa`, { regra, inicio: f.inicio || undefined, fim: f.fim || null, maxEnvios: f.maxEnvios ? Number(f.maxEnvios) : null })
        .then(setHorarios).catch((e) => setHorarios({ erro: (e as Error).message }));
    }, 400);
    return () => clearTimeout(t);
  }, [JSON.stringify(regra), f.inicio, f.fim, f.maxEnvios]);
  useEffect(() => {
    const id = prevCli || f.clienteIds[0];
    if (!id || !f.mensagem.trim()) { setPrevia(null); return; }
    const t = setTimeout(() => { post(`${API}/preview`, { clienteId: id, mensagem: f.mensagem, assunto: f.canais.includes('EMAIL') ? f.assunto || null : null }).then(setPrevia).catch(() => setPrevia(null)); }, 400);
    return () => clearTimeout(t);
  }, [f.mensagem, f.assunto, prevCli, f.clienteIds.join(','), f.canais.join(',')]);

  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const umCliente = f.clienteIds.length === 1 ? f.clienteIds[0] : null;
  const boletosCli = useApi<{ items: Boleto[] }>(f.categoria === 'COBRANCA' && umCliente ? `${API}/boletos?clienteId=${umCliente}&status=ABERTOS` : null, [umCliente, f.categoria]);
  const arquivos = useApi<{ items: Arquivo[] }>(`${API}/arquivos?${umCliente ? '' : 'clienteId=nenhum'}`, [umCliente]);
  const moverAnexo = (i: number, d: number) => { const n = [...anexos]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setAnexos(n); };
  const salvar = (ativar: boolean) => run(async () => {
    const body: any = {
      nome: f.nome, categoria: f.categoria, canais: f.canais, channelId: f.channelId || null, assunto: f.assunto || null, mensagem: f.mensagem,
      clienteIds: f.clienteIds, regra, inicio: f.inicio || undefined, fim: f.fim || null, maxEnvios: f.maxEnvios ? Number(f.maxEnvios) : null,
      anexos: anexos.map((x) => ({ envio: x.envio ?? null, arquivoId: x.arquivoId ?? null, boletoId: x.boletoId ?? null })),
      ...(f.categoria === 'COBRANCA' ? { reenvio: reenvio && reenvio.offsets?.length ? { ...reenvio, mensagem: reenvio.mensagem || null } : null } : {}),
    };
    if (automacao) {
      await patch(`${API}/automacoes/${automacao.id}`, { ...body, escopo: 'PROXIMOS' });
      if (ativar && automacao.status === 'RASCUNHO') await post(`${API}/automacoes/${automacao.id}/ativar`);
    } else await post(`${API}/automacoes`, { ...body, ativar });
    onSaved();
  }, ativar ? 'Automação salva e ativada' : 'Automação salva');

  const horariosField = (key = 'horarios') => (
    <Field label="Horários (separados por vírgula)" hint="ex.: 09:00, 13:00, 18:00 — cada horário vira um envio exato">
      <input value={(regra[key] ?? []).join(', ')} onChange={(e) => setRegra({ ...regra, [key]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
    </Field>
  );
  const tipoChange = (tipo: string) => {
    const base: Record<string, any> = {
      UNICO: { tipo, data: hoje, horario: '09:00' }, DIARIO: { tipo, horarios: ['09:00'] }, SEMANAL: { tipo, diasSemana: [1], horarios: ['09:00'] },
      MENSAL: { tipo, diasMes: [10], horarios: ['09:00'] }, DATAS: { tipo, datas: [{ data: hoje, horario: '09:00' }] }, ANUAL: { tipo, datas: [hoje.slice(5)], horarios: ['09:00'] },
      INTERVALO: { tipo, a_cada: 1, unidade: 'DIAS', horario: '09:00' },
    };
    setRegra(base[tipo]);
  };

  return (
    <Modal title={automacao ? 'Editar agendamento' : 'Novo agendamento'} onClose={onClose}>
      <div className="stack">
        {automacao?.status === 'ATIVA' && <div className="alert warn">As mudanças valem <strong>só para os próximos envios</strong>. O que já foi enviado (ou falhou) não é reenviado. Para mudar um envio específico, abra a automação e edite apenas aquela ocorrência.</div>}
        <div className="grid g2">
          <Field label="Nome *"><input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Field>
          <Field label="Categoria"><select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value as Categoria })} disabled={!!categoria || !!automacao}><option value="LEMBRETE">Lembrete</option><option value="MARKETING">Marketing</option><option value="COBRANCA">Cobrança</option></select></Field>
        </div>
        <div className="row">
          {(['WHATSAPP', 'EMAIL'] as Canal[]).map((c) => <label key={c} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.canais.includes(c)} onChange={() => setF({ ...f, canais: toggle(f.canais, c) })} /> {CANAL_LABEL[c]}</label>)}
          {f.canais.includes('WHATSAPP') && (channels.data?.length ?? 0) > 1 && (
            <select value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value })} style={{ width: 'auto' }}>
              <option value="">Canal WhatsApp conectado (automático)</option>{channels.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        {f.canais.includes('EMAIL') && <Field label="Assunto do e-mail"><input value={f.assunto} onChange={(e) => setF({ ...f, assunto: e.target.value })} /></Field>}
        {(modelos.data?.length ?? 0) > 0 && (
          <select value="" onChange={(e) => { const m = modelos.data!.find((x) => x.id === e.target.value); if (m) setF({ ...f, mensagem: m.corpo, assunto: m.assunto ?? f.assunto }); }}>
            <option value="">Usar um modelo de {CAT_LABEL[f.categoria].toLowerCase()}…</option>{modelos.data!.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        )}
        <Field label="Mensagem *"><textarea rows={4} value={f.mensagem} onChange={(e) => setF({ ...f, mensagem: e.target.value })} /></Field>
        <div className="mm-chips">{[...(vars.data?.disponiveis ?? []), ...(f.categoria === 'COBRANCA' ? (vars.data?.boleto ?? []).filter((v) => !vars.data!.disponiveis.some((d) => d.chave === v.chave)) : [])].map((v) => <button key={v.chave} className="btn sm" title={v.rotulo} onClick={() => setF({ ...f, mensagem: `${f.mensagem}{{${v.chave}}}` })}>{`{{${v.chave}}}`}</button>)}</div>
        {f.categoria === 'COBRANCA' && <p className="small muted" style={{ margin: 0 }}>Nas mensagens com boleto anexado, {'{{valor_parcela}}'}, {'{{numero_parcela}}'}, {'{{data_vencimento}}'}, {'{{valor_pendente}}'}, {'{{linha_digitavel}}'} e {'{{link_pagamento}}'} vêm do boleto daquela mensagem.</p>}

        <Field label={`Destinatários (${f.clienteIds.length} selecionado(s))`}>
          <input placeholder="Buscar cliente" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </Field>
        <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
          <div className="row small" style={{ marginBottom: 4 }}>
            <button className="btn sm" onClick={() => setF({ ...f, clienteIds: [...new Set([...f.clienteIds, ...(clientes.data?.items ?? []).map((c) => c.id)])] })}>Selecionar todos da lista</button>
            <button className="btn sm" onClick={() => setF({ ...f, clienteIds: [] })}>Limpar</button>
          </div>
          {clientes.data?.items.map((c) => (
            <label key={c.id} className="row small" style={{ padding: '2px 0' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={f.clienteIds.includes(c.id)} onChange={() => setF({ ...f, clienteIds: toggle(f.clienteIds, c.id) })} />
              {c.nome} <span className="muted">{c.whatsapp ?? c.email ?? ''}</span>
              {!c.consentimento && <span className="badge red">sem consentimento</span>}
              {f.categoria === 'MARKETING' && c.marketingOptOut && <span className="badge amber">opt-out</span>}
            </label>
          ))}
        </div>

        <Field label="Frequência"><select value={regra.tipo} onChange={(e) => tipoChange(e.target.value)}>{TIPOS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select></Field>
        {regra.tipo === 'UNICO' && <div className="grid g2"><Field label="Data"><input type="date" value={regra.data} onChange={(e) => setRegra({ ...regra, data: e.target.value })} /></Field><Field label="Horário"><input type="time" value={regra.horario} onChange={(e) => setRegra({ ...regra, horario: e.target.value })} /></Field></div>}
        {regra.tipo === 'DIARIO' && horariosField()}
        {regra.tipo === 'SEMANAL' && <>
          <div className="row">{DIAS.map((d, i) => <label key={d} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={regra.diasSemana.includes(i)} onChange={() => setRegra({ ...regra, diasSemana: toggle(regra.diasSemana, i).sort() })} /> {d}</label>)}</div>
          {horariosField()}
        </>}
        {regra.tipo === 'MENSAL' && <>
          <Field label="Dias do mês (separados por vírgula)" hint="dia 31 em meses mais curtos vira o último dia"><input value={regra.diasMes.join(', ')} onChange={(e) => setRegra({ ...regra, diasMes: e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 31) })} /></Field>
          {horariosField()}
        </>}
        {regra.tipo === 'DATAS' && (
          <div className="stack">
            {regra.datas.map((d: any, i: number) => (
              <div key={i} className="row">
                <input type="date" value={d.data} style={{ width: 'auto' }} onChange={(e) => setRegra({ ...regra, datas: regra.datas.map((x: any, j: number) => (j === i ? { ...x, data: e.target.value } : x)) })} />
                <input type="time" value={d.horario} style={{ width: 'auto' }} onChange={(e) => setRegra({ ...regra, datas: regra.datas.map((x: any, j: number) => (j === i ? { ...x, horario: e.target.value } : x)) })} />
                <span className="small muted">Mensagem {i + 1}</span>
                <input placeholder="Texto só desta mensagem (opcional)" value={d.mensagem ?? ''} style={{ flex: 1, minWidth: 160 }} onChange={(e) => setRegra({ ...regra, datas: regra.datas.map((x: any, j: number) => (j === i ? { ...x, mensagem: e.target.value || undefined } : x)) })} />
                <button className="btn sm" onClick={() => setRegra({ ...regra, datas: regra.datas.filter((_: any, j: number) => j !== i) })} disabled={regra.datas.length <= 1}>Remover</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setRegra({ ...regra, datas: [...regra.datas, { ...regra.datas[regra.datas.length - 1] }] })}>+ Adicionar data</button>
          </div>
        )}
        {regra.tipo === 'ANUAL' && <>
          <Field label="Datas (DD/MM, separadas por vírgula)"><input value={regra.datas.map((d: string) => d.split('-').reverse().join('/')).join(', ')} onChange={(e) => setRegra({ ...regra, datas: e.target.value.split(',').map((s) => s.trim()).filter((s) => /^\d{2}\/\d{2}$/.test(s)).map((s) => s.split('/').reverse().join('-')) })} /></Field>
          {horariosField()}
        </>}
        {regra.tipo === 'INTERVALO' && (
          <div className="grid g3">
            <Field label="A cada"><input type="number" min={1} value={regra.a_cada} onChange={(e) => setRegra({ ...regra, a_cada: Number(e.target.value) })} /></Field>
            <Field label="Unidade"><select value={regra.unidade} onChange={(e) => setRegra({ ...regra, unidade: e.target.value })}>{['MINUTOS', 'HORAS', 'DIAS', 'SEMANAS', 'MESES'].map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}</select></Field>
            {!['MINUTOS', 'HORAS'].includes(regra.unidade) && <Field label="Horário"><input type="time" value={regra.horario ?? '09:00'} onChange={(e) => setRegra({ ...regra, horario: e.target.value })} /></Field>}
          </div>
        )}
        {regra.tipo !== 'UNICO' && regra.tipo !== 'DATAS' && (
          <div className="grid g3">
            <Field label="Início"><input type="date" value={f.inicio} onChange={(e) => setF({ ...f, inicio: e.target.value })} /></Field>
            <Field label="Término (opcional)"><input type="date" value={f.fim} onChange={(e) => setF({ ...f, fim: e.target.value })} /></Field>
            <Field label="Máximo de envios"><input type="number" min={1} value={f.maxEnvios} onChange={(e) => setF({ ...f, maxEnvios: e.target.value })} placeholder="sem limite" /></Field>
          </div>
        )}
        <div className="card stack" style={{ padding: 10 }}>
          <strong className="small">Anexos (na ordem da lista){f.categoria === 'COBRANCA' ? ' — escolha em qual mensagem vai cada boleto' : ''}</strong>
          {anexos.length === 0 && <div className="small muted">Nenhum anexo. Mensagem "todas" = o arquivo vai em todos os envios; um número = só naquela mensagem da sequência.</div>}
          {anexos.map((x, i) => (
            <div key={i} className="row small" style={{ flexWrap: 'nowrap' }}>
              <span style={{ flex: 1 }}>{x.boletoId ? <>💲 {x.boleto?.descricao ?? boletosCli.data?.items.find((b) => b.id === x.boletoId)?.descricao ?? 'Boleto'}{(x.boleto?.parcela ?? boletosCli.data?.items.find((b) => b.id === x.boletoId)?.parcela) ? ` · parcela ${x.boleto?.parcela ?? boletosCli.data?.items.find((b) => b.id === x.boletoId)?.parcela}` : ''}</> : <>📎 {x.nome ?? arqNomes[x.arquivoId!] ?? arquivos.data?.items.find((a) => a.id === x.arquivoId)?.nome ?? 'Arquivo'}</>}</span>
              <span className="muted">mensagem</span>
              <input type="number" min={1} placeholder="todas" value={x.envio ?? ''} style={{ width: 80 }} onChange={(e) => setAnexos(anexos.map((y, j) => (j === i ? { ...y, envio: e.target.value ? Number(e.target.value) : null } : y)))} />
              <button className="btn sm" onClick={() => moverAnexo(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
              <button className="btn sm" onClick={() => moverAnexo(i, 1)} disabled={i === anexos.length - 1} aria-label="Descer">↓</button>
              <button className="btn sm" onClick={() => setAnexos(anexos.filter((_, j) => j !== i))}>Remover</button>
            </div>
          ))}
          <div className="row small">
            <select value="" style={{ width: 'auto', maxWidth: 260 }} onChange={(e) => { const a = arquivos.data?.items.find((y) => y.id === e.target.value); if (a) setAnexos([...anexos, { envio: null, arquivoId: a.id, boletoId: null, nome: a.nome }]); }}>
              <option value="">+ Arquivo já enviado…</option>{arquivos.data?.items.filter((a) => !a.clienteId || a.clienteId === umCliente).map((a) => <option key={a.id} value={a.id}>{a.nome}{a.cliente ? ` (${a.cliente})` : ''}</option>)}
            </select>
            <UploadButton label="+ Enviar arquivo" query={umCliente ? `?clienteId=${umCliente}` : ''} onDone={(a) => { setArqNomes({ ...arqNomes, [a.id]: a.nome }); setAnexos([...anexos, { envio: null, arquivoId: a.id, boletoId: null, nome: a.nome }]); arquivos.reload(); }} />
            {f.categoria === 'COBRANCA' && (umCliente ? (
              <select value="" style={{ width: 'auto', maxWidth: 300 }} onChange={(e) => { const b = boletosCli.data?.items.find((y) => y.id === e.target.value); if (b) setAnexos([...anexos, { envio: Math.max(0, ...anexos.filter((y) => y.boletoId).map((y) => y.envio ?? 0)) + 1, arquivoId: null, boletoId: b.id }]); }}>
                <option value="">+ Boleto do cliente…</option>{boletosCli.data?.items.filter((b) => !anexos.some((y) => y.boletoId === b.id) && ['PENDENTE', 'VENCIDO', 'PARCIAL'].includes(b.status)).map((b) => <option key={b.id} value={b.id}>{b.descricao}{b.parcela ? ` · parcela ${b.parcela}` : ''} · vence {fmtYmd(b.vencimentoData)} · {brl(b.saldo)}</option>)}
              </select>
            ) : <span className="muted">Para anexar boletos, escolha um único cliente.</span>)}
          </div>
          {!umCliente && f.clienteIds.length > 1 && <div className="small muted">Com vários clientes, só documentos gerais (sem cliente) podem ser anexados — evita enviar o documento de um cliente para outro.</div>}
        </div>
        {f.categoria === 'COBRANCA' && (
          <div className="card stack" style={{ padding: 10 }}>
            <label className="mm-check"><input type="checkbox" checked={!!reenvio} onChange={(e) => setReenvio(e.target.checked ? { offsets: [0, 1, 3, 7], horario: '10:00', maxPorBoleto: 3, mensagem: '' } : null)} /> Reenviar boletos pendentes ou vencidos (nunca os pagos)</label>
            {reenvio && <>
              <div className="grid g3">
                <Field label="Dias em relação ao vencimento" hint="-1 = véspera, 0 = no dia, 1/3/7 = depois"><input defaultValue={reenvio.offsets.join(', ')} onBlur={(e) => setReenvio({ ...reenvio, offsets: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n)) })} /></Field>
                <Field label="Horário"><input type="time" value={reenvio.horario} onChange={(e) => setReenvio({ ...reenvio, horario: e.target.value })} /></Field>
                <Field label="Máximo de reenvios por boleto"><input type="number" min={1} max={50} value={reenvio.maxPorBoleto} onChange={(e) => setReenvio({ ...reenvio, maxPorBoleto: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Mensagem do reenvio (vazio = mesma mensagem)"><textarea rows={2} value={reenvio.mensagem ?? ''} onChange={(e) => setReenvio({ ...reenvio, mensagem: e.target.value })} /></Field>
            </>}
          </div>
        )}
        {horarios && (horarios.erro ? <div className="alert err small">{horarios.erro}</div> : (
          <div className="small"><strong>{horarios.descricao}</strong> — próximos: {horarios.proximos.length ? horarios.proximos.slice(0, 6).map((d: string) => fmtDT(d)).join(' · ') : 'nenhum horário futuro'}</div>
        ))}

        {f.clienteIds.length > 0 && f.mensagem.trim() && (
          <div className="stack">
            <div className="row small"><strong>Prévia com os dados de</strong>
              <select value={prevCli || f.clienteIds[0]} onChange={(e) => setPrevCli(e.target.value)} style={{ width: 'auto' }}>
                {f.clienteIds.map((id) => <option key={id} value={id}>{clientes.data?.items.find((c) => c.id === id)?.nome ?? id}</option>)}
              </select>
            </div>
            {previa && <div className="mm-preview">{previa.assunto && <div className="small"><strong>Assunto:</strong> {previa.assunto}</div>}<div className="b">{previa.texto}</div></div>}
            {previa?.bloqueado && <div className="alert err small">{previa.problema}. Corrija o cadastro ou a mensagem: a ativação fica bloqueada.</div>}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          {(!automacao || automacao.status === 'RASCUNHO') && <button className="btn" disabled={busy || !f.nome.trim() || !f.mensagem.trim()} onClick={() => salvar(false)}>Salvar rascunho</button>}
          <button className="btn primary" disabled={busy || !f.nome.trim() || !f.mensagem.trim() || !f.canais.length || !f.clienteIds.length} onClick={() => salvar(true)}>
            {automacao && automacao.status !== 'RASCUNHO' ? 'Salvar (próximos envios)' : 'Salvar e ativar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Detalhe({ id, onClose }: { id: string; onClose: () => void }) {
  const ro = useReadOnly();
  const d = useApi<Automacao & { proximas: Ocorrencia[]; processadas: Ocorrencia[] }>(`${API}/automacoes/${id}`);
  const { busy, run } = useAction();
  const [editOc, setEditOc] = useState<Ocorrencia | null>(null);
  const [nomes, setNomes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!d.data) return;
    get<{ items: Cliente[] }>(`${API}/clientes?pageSize=500`).then((r) => setNomes(Object.fromEntries(r.items.map((c) => [c.id, c.nome])))).catch(() => undefined);
  }, [d.data?.id]);
  const linha = (o: Ocorrencia, a: Automacao) => (
    <tr key={o.id}>
      <td className="small">{fmtDT(o.agendadoPara, a.timezone)}{o.editada && <span className="badge" style={{ marginLeft: 4 }}>editada</span>}{(o as any).tipo && (o as any).tipo !== 'ENVIO' && <span className="badge" style={{ marginLeft: 4 }}>reenvio</span>}{(o as any).indice && <span className="muted"> · msg {(o as any).indice}</span>}</td>
      <td className="small">{nomes[o.clienteId] ?? '…'}</td><td className="small">{CANAL_LABEL[o.canal]}</td>
      <td><OcBadge s={o.status} />{o.tentativas > 0 && <span className="small muted"> {o.tentativas}x</span>}{o.erro && <div className="small" style={{ color: 'var(--danger)' }}>{o.erro}</div>}</td>
      <td>{!ro && o.status === 'PENDENTE' && <div className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="btn sm" onClick={() => setEditOc(o)}>Só esta</button>
        <button className="btn sm danger" disabled={busy} onClick={() => run(async () => { await post(`${API}/ocorrencias/${o.id}/cancelar`); d.reload(); }, 'Envio cancelado')}>Cancelar</button>
      </div>}
      {!ro && (o.status === 'FALHOU' || o.status === 'IGNORADA') && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await post(`${API}/ocorrencias/${o.id}/reprocessar`); d.reload(); }, 'Envio recolocado na fila')}>Reprocessar</button>}</td>
    </tr>
  );
  return (
    <Modal title="Automação" onClose={onClose}>
      <Async state={d}>{(a) => (
        <div className="stack">
          <div className="row between"><div><h3 style={{ margin: 0 }}>{a.nome}</h3><div className="small muted">{CAT_LABEL[a.categoria]} · {a.descricao} · {a.canais.map((c) => CANAL_LABEL[c]).join(' + ')}</div></div><AutoBadge s={a.status} /></div>
          <div className="mm-preview"><div className="b">{a.mensagem}</div></div>
          {(a.anexos?.length ?? 0) > 0 && <div className="small"><strong>Anexos:</strong>
            {a.anexos!.map((x) => <div key={x.id}>{x.envio ? `Mensagem ${x.envio}` : 'Todas as mensagens'} → {x.boleto ? <>{x.boleto.descricao}{x.boleto.parcela ? ` · parcela ${x.boleto.parcela}` : ''} · vence {fmtYmd(x.boleto.vencimento)} <BolBadge s={x.boleto.status} />{!x.boleto.temArquivo && <span className="badge amber">sem PDF</span>}</> : x.arquivoId ? <ArquivoLink id={x.arquivoId} nome={x.nome ?? 'arquivo'} /> : null}</div>)}
          </div>}
          {a.reenvio && <div className="small"><strong>Reenvio:</strong> {a.reenvio.offsets.map((o) => (o === 0 ? 'no dia' : o < 0 ? `${-o} dia(s) antes` : `${o} dia(s) depois`)).join(', ')} do vencimento, às {a.reenvio.horario}, até {a.reenvio.maxPorBoleto}x por boleto.</div>}
          {!ro && <TestarEnvio a={a} />}
          <h4 style={{ margin: 0 }}>Próximos envios</h4>
          <div className="table-wrap"><table><tbody>{a.proximas.length ? a.proximas.map((o) => linha(o, a)) : <tr><td className="small muted">Nenhum envio programado.</td></tr>}</tbody></table></div>
          <h4 style={{ margin: 0 }}>Já processados</h4>
          <div className="table-wrap"><table><tbody>{a.processadas.length ? [...a.processadas].reverse().map((o) => linha(o, a)) : <tr><td className="small muted">Nada processado ainda.</td></tr>}</tbody></table></div>
          {editOc && <EditOcorrencia o={editOc} tz={a.timezone} onClose={() => setEditOc(null)} onSaved={() => { setEditOc(null); d.reload(); }} />}
        </div>
      )}</Async>
    </Modal>
  );
}

function EditOcorrencia({ o, tz, onClose, onSaved }: { o: Ocorrencia; tz: string; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction();
  const [data, setData] = useState(ymdLocal(new Date(o.agendadoPara), tz));
  const [horario, setHorario] = useState(hmLocal(o.agendadoPara, tz));
  const [mensagem, setMensagem] = useState(o.mensagem ?? '');
  return (
    <div className="card stack" style={{ background: 'var(--brand-soft)' }}>
      <strong className="small">Alterar só este envio (o restante da sequência não muda)</strong>
      <div className="row"><input type="date" value={data} onChange={(e) => setData(e.target.value)} style={{ width: 'auto' }} /><input type="time" value={horario} onChange={(e) => setHorario(e.target.value)} style={{ width: 'auto' }} /></div>
      <textarea rows={3} placeholder="Texto só deste envio (vazio = texto da automação)" value={mensagem} onChange={(e) => setMensagem(e.target.value)} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn sm" onClick={onClose}>Cancelar</button>
        <button className="btn sm primary" disabled={busy} onClick={() => run(async () => { await patch(`${API}/ocorrencias/${o.id}`, { data, horario, mensagem: mensagem || null }); onSaved(); }, 'Envio alterado')}>Salvar este envio</button>
      </div>
    </div>
  );
}

/** Teste de envio para um destinatário autorizado (não conta como envio da sequência). */
function TestarEnvio({ a }: { a: Automacao }) {
  const { busy, run } = useAction();
  const [aberto, setAberto] = useState(false);
  const [clienteId, setClienteId] = useState(a.clienteIds[0] ?? '');
  const [canal, setCanal] = useState<Canal>(a.canais[0] ?? 'WHATSAPP');
  const [envio, setEnvio] = useState('1');
  const [res, setRes] = useState<any>(null);
  const clientes = useApi<{ items: Cliente[] }>(aberto ? `${API}/clientes?pageSize=500` : null, [aberto]);
  if (!aberto) return <div><button className="btn sm" onClick={() => setAberto(true)}>Testar envio</button></div>;
  return (
    <div className="card stack" style={{ background: 'var(--brand-soft)' }}>
      <strong className="small">Teste de envio (sai agora, marcado como [TESTE]; não altera a sequência)</strong>
      <div className="row">
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} style={{ width: 'auto', maxWidth: 260 }}>{clientes.data?.items.filter((c) => c.consentimento).map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select>
        <select value={canal} onChange={(e) => setCanal(e.target.value as Canal)} style={{ width: 'auto' }}><option value="WHATSAPP">WhatsApp</option><option value="EMAIL">E-mail</option></select>
        <span className="small muted">mensagem nº</span><input type="number" min={1} value={envio} onChange={(e) => setEnvio(e.target.value)} style={{ width: 70 }} />
        <button className="btn sm primary" disabled={busy || !clienteId} onClick={() => run(async () => {
          try { setRes(await post(`${API}/automacoes/${a.id}/testar`, { clienteId, canal, envio: Number(envio) || 1 })); } catch (e) { setRes({ ok: false, erro: (e as Error).message }); }
        })}>Enviar teste</button>
        <button className="btn sm" onClick={() => setAberto(false)}>Fechar</button>
      </div>
      {res && <div className={`alert ${res.ok ? 'ok' : 'err'} small`}>{res.ok ? <>Enviado.{res.anexos?.length ? ` Anexos: ${res.anexos.join(', ')}.` : ''}<div style={{ whiteSpace: 'pre-wrap' }}>{res.texto}</div></> : `Não enviado: ${res.erro ?? res.error}`}</div>}
    </div>
  );
}
