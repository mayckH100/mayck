/**
 * v1.46.0 — "Monte sua IA conversando": o dono cola o link do site/Instagram, escreve sobre o negócio ou envia PDF/áudio;
 * a IA monta base de conhecimento, instruções, fluxo de boas-vindas e horário. Prévia editável; nada é gravado antes de "Aplicar".
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, upload } from '../api';
import { Modal, Field, useAction, Loading } from '../ui';

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
type Arq = { nome: string; tipo: 'arquivo' | 'audio'; texto: string; caracteres: number };
const linhas = (v: string) => v.split('\n').map((l) => l.trim()).filter(Boolean);

export function useSituacaoMontar(ativo = true) {
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (ativo) get('/ai/montar').then(setS).catch(() => setS(null)); }, [ativo]);
  return s;
}

export default function MontarIaModal({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const [sit, setSit] = useState<any>(null);
  const [link, setLink] = useState('');
  const [texto, setTexto] = useState('');
  const [arquivos, setArquivos] = useState<Arq[]>([]);
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState('');
  const [p, setP] = useState<any>(null);
  const [fontes, setFontes] = useState<string[]>([]);
  const [op, setOp] = useState({ ligarIa: true, criarFluxo: true, ativarFluxo: true, horario: true, substituirInstrucoes: false });
  const [feito, setFeito] = useState<{ feito: string[]; fluxoAviso: string | null } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { get('/ai/montar').then((s) => { setSit(s); setOp((o) => ({ ...o, ativarFluxo: !s.outroFluxoAtivo, horario: !s.temHorario })); }).catch((e) => setErro(e.message)); }, []);

  const enviarArquivos = async (files: FileList | null) => {
    if (!files?.length) return;
    setErro('');
    setLendo(true);
    try {
      for (const f of Array.from(files).slice(0, 5 - arquivos.length)) {
        try {
          const r = await upload<Arq>('/ai/montar/arquivo', f);
          setArquivos((a) => [...a, r]);
        } catch (e) { setErro(`${f.name}: ${(e as Error).message}`); }
      }
    } finally { setLendo(false); }
  };

  const gerar = () => run(async () => {
    setErro('');
    const r = await post<any>('/ai/montar/gerar', { link: link || null, texto: texto || null, arquivos: arquivos.map(({ nome, tipo, texto: t }) => ({ nome, tipo, texto: t })) }, { timeoutMs: 120000, timeoutMessage: 'A IA demorou demais. Tente de novo com menos texto.' });
    setP(r.proposta);
    setFontes(r.fontes);
    setOp((o) => ({ ...o, horario: o.horario && r.proposta.horarios.length > 0 }));
  }).then(() => undefined);

  const aplicar = () => run(async () => {
    const r = await post<any>('/ai/montar/aplicar', { confirmar: true, proposta: p, opcoes: op });
    setFeito(r);
    onApplied?.();
  }, 'Pronto! Sua IA foi configurada.');

  const set = (k: string, v: unknown) => setP({ ...p, [k]: v });
  const setItem = (k: string, i: number, campo: string, v: unknown) => set(k, p[k].map((x: any, j: number) => (j === i ? { ...x, [campo]: v, ...(campo === 'preco' ? { precoConferido: true } : {}) } : x)));
  const tira = (k: string, i: number) => set(k, p[k].filter((_: unknown, j: number) => j !== i));

  if (feito) {
    return (
      <Modal title="Sua IA está pronta" onClose={onClose}>
        <div className="stack">
          <div className="alert ok">✅ Aplicado: {feito.feito.join(', ')}.</div>
          {feito.fluxoAviso && <div className="alert warn small">{feito.fluxoAviso}</div>}
          <p className="small muted" style={{ margin: 0 }}>Faça uma pergunta como se fosse um cliente para conferir. Você pode ajustar tudo depois em IA, Fluxos e Inbox › Atendimento.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Link className="btn" to="/fluxos" onClick={onClose}>Ver fluxo</Link>
            <Link className="btn primary" to="/ia?aba=testar" onClick={onClose}>Testar a IA agora</Link>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="✨ Monte sua IA conversando" onClose={onClose}>
      {!sit && !erro ? <Loading /> : !p ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); gerar(); }}>
          <p className="small muted" style={{ margin: 0 }}>Mostre seu negócio para a IA. Ela lê, separa produtos, preços, horários e regras, e monta a base de conhecimento e as boas-vindas. Você confere tudo antes de aplicar.</p>
          {sit && !sit.disponivel && <div className="alert warn small">{sit.motivo}</div>}
          {sit?.modo === 'mck' && <div className="small muted">Usando a MCK IA (conta na cota diária da sua empresa).</div>}
          <Field label="Link do site ou Instagram" hint="Ex.: www.minhaloja.com.br ou @minhaloja"><input value={link} onChange={(e) => setLink(e.target.value)} placeholder="www.seusite.com.br ou @seuinstagram" inputMode="url" autoComplete="off" /></Field>
          <Field label="Conte sobre o seu negócio" hint="O que você vende, preços, horários, endereço, formas de pagamento, entrega e o que a IA nunca deve prometer.">
            <textarea rows={6} maxLength={20000} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ex.: Somos a Pet Feliz, banho e tosa em Osasco. Banho pequeno porte R$ 45, médio R$ 60. Atendemos seg a sex 9h às 18h e sábado 9h às 13h. Pix, cartão e dinheiro. Não fazemos busca em casa." />
          </Field>
          <Field label="PDF de preços, cardápio ou áudio explicando (opcional)" hint="Até 5 arquivos de 8 MB: PDF, TXT/CSV ou áudio (até 5 minutos).">
            <input type="file" multiple accept=".pdf,.txt,.csv,audio/*,.ogg,.opus,.mp3,.m4a" disabled={lendo || arquivos.length >= 5} onChange={(e) => { enviarArquivos(e.target.files); e.target.value = ''; }} />
          </Field>
          {lendo && <div className="small muted">Lendo arquivo…</div>}
          {arquivos.map((a, i) => (
            <div key={i} className="row between small"><span>{a.tipo === 'audio' ? '🎙️' : '📄'} {a.nome} · {a.caracteres} caracteres lidos</span><button type="button" className="btn sm ghost" onClick={() => setArquivos(arquivos.filter((_, j) => j !== i))}>Remover</button></div>
          ))}
          {erro && <div className="alert err small">{erro}</div>}
          <button className="btn primary" disabled={busy || lendo || !sit?.disponivel || (!link.trim() && !texto.trim() && !arquivos.length)}>{busy ? 'Lendo e montando… (até 1 minuto)' : 'Montar com a IA'}</button>
        </form>
      ) : (
        <div className="stack">
          <div className="small muted">Lido de: {fontes.join(' · ')}. Confira e corrija antes de aplicar — a IA só usa o que estiver aqui.</div>
          <Field label="Empresa"><input value={p.empresa} maxLength={120} onChange={(e) => set('empresa', e.target.value)} /></Field>
          <Field label="Sobre a empresa"><textarea rows={3} maxLength={800} value={p.resumo} onChange={(e) => set('resumo', e.target.value)} /></Field>

          <strong>Produtos e preços ({p.produtos.length})</strong>
          {p.produtos.map((x: any, i: number) => (
            <div key={i} className="stack" style={{ gap: 4, borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input aria-label="Produto" value={x.nome} maxLength={120} onChange={(e) => setItem('produtos', i, 'nome', e.target.value)} />
                <input aria-label="Preço" value={x.preco} maxLength={60} style={{ maxWidth: 130 }} onChange={(e) => setItem('produtos', i, 'preco', e.target.value)} placeholder="R$" />
                <button type="button" className="btn sm ghost" aria-label="Remover produto" onClick={() => tira('produtos', i)}>✕</button>
              </div>
              {!x.precoConferido && <span className="small" style={{ color: '#a15c00' }}>⚠️ Esse preço não aparece nas fontes. Confira antes de aplicar.</span>}
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => set('produtos', [...p.produtos, { nome: '', preco: '', descricao: '', precoConferido: true }])}>+ Produto</button>

          <strong>Horário de atendimento</strong>
          {p.horarios.length === 0 && <span className="small muted">Nenhum horário encontrado. Adicione se quiser a mensagem automática de fora do horário.</span>}
          {p.horarios.map((h: any, i: number) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <select aria-label="Dia" value={h.dia} onChange={(e) => setItem('horarios', i, 'dia', Number(e.target.value))} style={{ maxWidth: 90 }}>{DIAS.map((d, j) => <option key={j} value={j}>{d}</option>)}</select>
              <input aria-label="Início" type="time" value={h.inicio} onChange={(e) => setItem('horarios', i, 'inicio', e.target.value)} />
              <input aria-label="Fim" type="time" value={h.fim} onChange={(e) => setItem('horarios', i, 'fim', e.target.value)} />
              <button type="button" className="btn sm ghost" aria-label="Remover horário" onClick={() => tira('horarios', i)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => set('horarios', [...p.horarios, { dia: 1, inicio: '09:00', fim: '18:00' }])}>+ Horário</button>

          <Field label="Endereço"><input value={p.endereco} maxLength={300} onChange={(e) => set('endereco', e.target.value)} /></Field>
          <Field label="Formas de pagamento"><input value={p.pagamento} maxLength={300} onChange={(e) => set('pagamento', e.target.value)} /></Field>
          <Field label="Entrega / retirada"><input value={p.entrega} maxLength={400} onChange={(e) => set('entrega', e.target.value)} /></Field>
          <Field label="Regras e políticas (uma por linha)"><textarea rows={3} value={p.regras.join('\n')} onChange={(e) => set('regras', linhas(e.target.value))} /></Field>
          <Field label="A IA nunca deve prometer (uma por linha)"><textarea rows={3} value={p.nuncaPrometer.join('\n')} onChange={(e) => set('nuncaPrometer', linhas(e.target.value))} /></Field>
          <Field label="Mensagem de boas-vindas"><textarea rows={2} maxLength={400} value={p.boasVindas} onChange={(e) => set('boasVindas', e.target.value)} /></Field>
          <Field label="Opções do menu (setores, uma por linha)" hint={'"Falar com um atendente" entra sempre como última opção.'}><textarea rows={3} value={p.setores.join('\n')} onChange={(e) => set('setores', linhas(e.target.value).slice(0, 4))} /></Field>
          <Field label="Mensagem de fora do horário" hint="{nome} e {horario} são trocados pelos dados reais."><textarea rows={2} maxLength={400} value={p.foraDoHorario} onChange={(e) => set('foraDoHorario', e.target.value)} placeholder="Agora estamos fora do horário. Respondemos assim que voltarmos. Nosso horário: {horario}." /></Field>

          <div className="card stack" style={{ gap: 6 }}>
            <strong>Ao aplicar</strong>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={op.ligarIa} onChange={(e) => setOp({ ...op, ligarIa: e.target.checked })} /> Ligar a IA para responder no WhatsApp{sit?.iaLigada ? ' (já está ligada)' : ''}</label>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={op.criarFluxo} onChange={(e) => setOp({ ...op, criarFluxo: e.target.checked })} /> Criar o fluxo de boas-vindas com o menu{sit?.fluxoExistente ? ' (atualiza o que o assistente criou antes)' : ''}</label>
            {op.criarFluxo && <label className="row small" style={{ paddingLeft: 22 }}><input type="checkbox" style={{ width: 'auto' }} checked={op.ativarFluxo} disabled={!!sit?.outroFluxoAtivo} onChange={(e) => setOp({ ...op, ativarFluxo: e.target.checked })} /> Ativar agora{sit?.outroFluxoAtivo ? ` — o fluxo "${sit.outroFluxoAtivo}" já responde à primeira mensagem; este fica como rascunho` : ''}</label>}
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={op.horario} disabled={!p.horarios.length} onChange={(e) => setOp({ ...op, horario: e.target.checked })} /> Usar este horário e a mensagem de fora do horário{sit?.temHorario ? ' (substitui o horário configurado no Inbox)' : ''}</label>
            {sit?.temInstrucoes && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={op.substituirInstrucoes} onChange={(e) => setOp({ ...op, substituirInstrucoes: e.target.checked })} /> Substituir as instruções atuais da IA (desmarcado: só acrescenta/atualiza o bloco do assistente)</label>}
            {sit?.docsDoAssistente?.length > 0 && <span className="small muted">Os documentos criados antes pelo assistente ({sit.docsDoAssistente.length}) serão atualizados. Seus outros documentos não mudam.</span>}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setP(null)}>Voltar</button>
            <button type="button" className="btn primary" disabled={busy} onClick={aplicar}>{busy ? 'Aplicando…' : 'Aplicar'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
