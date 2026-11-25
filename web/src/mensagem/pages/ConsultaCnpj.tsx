import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { post } from '../../api';
import { useApi, Field, useAction, useToast, fmtNum } from '../../ui';
import { downloadCsv, type Campaign } from '../common';

/**
 * v1.53.0 — Consulta CNPJ / Prospecção. Só dados do cadastro público da empresa (fonte de CNPJ). Nada de dado pessoal
 * de sócio além do nome e da qualificação; CPF de sócio nunca aparece.
 */
interface Tel { e164: string; exibicao: string; celular: boolean; whatsapp: string | null }
interface Ficha {
  cnpj: string; razaoSocial: string; fantasia: string | null; situacao: string | null; ativa: boolean; dataSituacao: string | null; motivoSituacao: string | null;
  abertura: string | null; porte: string | null; naturezaJuridica: string | null; matrizFilial: string | null; capitalSocial: number | null; simples: 'MEI' | 'SIMPLES' | 'NORMAL' | null;
  cnaePrincipal: { codigo: string; descricao: string } | null; cnaesSecundarios: { codigo: string; descricao: string }[];
  endereco: { municipio: string | null; uf: string | null }; enderecoTexto: string | null; mapsUrl: string | null;
  telefones: Tel[]; email: string | null; socios: { nome: string; qualificacao: string | null; desde: string | null }[];
  fonte: string; consultadoEm: string; doCache?: boolean;
}
interface Uso { consultas: number; naFonte: number; limiteDia: number; cacheDias: number; loteMax: number }
interface ItemLote { cnpj: string; ok: boolean; ficha?: Ficha; erro?: string; status?: number }

const TAG_PADRAO = 'prospeccao-lojas';
const fmtCnpj = (c: string) => (/^\d{14}$/.test(c) ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c);
const fmtData = (d: string | null) => (d ? d.split('-').reverse().join('/') : '—');
const idade = (d: string | null) => {
  if (!d) return '';
  const anos = Math.floor((Date.now() - new Date(`${d}T12:00:00`).getTime()) / (365.25 * 864e5));
  return anos >= 1 ? ` · ${anos} ${anos === 1 ? 'ano' : 'anos'}` : ' · menos de 1 ano';
};
const cnae = (c: string) => (/^\d{7}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4, 5)}/${c.slice(5)}` : c);
const SIMPLES: Record<string, string> = { MEI: 'MEI', SIMPLES: 'Simples Nacional', NORMAL: 'Fora do Simples' };
const parseTags = (s: string) => [...new Set(s.split(/[,|]/).map((t) => t.trim()).filter(Boolean))].slice(0, 30);
/** Planilha: evita fórmula injetada (=, +, -, @) ao abrir no Excel. */
const seguro = (v: unknown) => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; };
const telPadrao = (f: Ficha) => f.telefones.find((t) => t.celular) ?? f.telefones[0] ?? null;
const donoDe = (f: Ficha) => (f.socios.find((s) => /administrador|titular|presidente|diretor|empres[áa]rio/i.test(s.qualificacao ?? '')) ?? f.socios[0])?.nome ?? '';

function AvisoB2B() {
  return (
    <div className="alert info small" role="note">
      <strong>Uso B2B:</strong> dados públicos do cadastro da empresa (CNPJ), para contato comercial com empresas. Toda mensagem deve oferecer saída
      (ex.: “responda SAIR”); quem pede para sair é bloqueado automaticamente e não volta a receber campanhas.
    </div>
  );
}

function Cartao({ titulo, children, extra }: { titulo: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="card stack cnpj-card">
      <div className="row between"><h3 style={{ margin: 0, fontSize: 15 }}>{titulo}</h3>{extra}</div>
      {children}
    </section>
  );
}

function useCampanhas() {
  const c = useApi<Campaign[]>('/mckmensagem/campaigns');
  return (c.data ?? []).filter((x) => x.status !== 'CONCLUIDA');
}

function Acoes({ ficha, campanhas }: { ficha: Ficha; campanhas: Campaign[] }) {
  const [tags, setTags] = useState(TAG_PADRAO);
  const [tel, setTel] = useState(telPadrao(ficha)?.e164 ?? '');
  const [campaignId, setCampaignId] = useState('');
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => { setTel(telPadrao(ficha)?.e164 ?? ''); }, [ficha.cnpj]);
  if (!ficha.telefones.length) return <p className="small muted">Esta empresa não tem telefone no cadastro, por isso não dá para adicioná-la aos contatos.</p>;
  const enviar = async (comCampanha: boolean) => {
    if (comCampanha && !campaignId) { toast('Escolha a campanha', 'err'); return; }
    const r = await run(() => post<{ criados: number; atualizados: number; naFila: number; bloqueados: number }>('/mckmensagem/cnpj/importar', {
      itens: [{ cnpj: ficha.cnpj, telefone: tel || null }], tags: parseTags(tags), campaignId: comCampanha ? campaignId : null,
    }));
    if (!r) return;
    if (r.bloqueados) toast('Este telefone pediu para sair (SAIR) e está bloqueado: não foi adicionado.', 'err');
    else toast(`${r.criados ? 'Contato adicionado' : 'Contato atualizado'}${comCampanha ? (r.naFila ? ' e colocado na fila da campanha' : ' na campanha') : ''}`);
  };
  return (
    <div className="stack">
      <div className="grid g2" style={{ gap: 10 }}>
        {ficha.telefones.length > 1 && (
          <Field label="Telefone do cadastro">
            <select value={tel} onChange={(e) => setTel(e.target.value)}>
              {ficha.telefones.map((t) => <option key={t.e164} value={t.e164}>{t.exibicao}{t.celular ? ' (celular)' : ' (fixo)'}</option>)}
            </select>
          </Field>
        )}
        <Field label="Etiqueta" hint="Separe por vírgula"><input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        <Field label="Campanha">
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Escolha…</option>
            {campanhas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => enviar(false)}>+ Adicionar aos contatos</button>
        <button className="btn" disabled={busy || !campaignId} onClick={() => enviar(true)}>➤ Adicionar à campanha</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>O contato fica com a empresa ({'{empresa}'}), o sócio/dono ({'{dono}'}) e a origem “Cadastro CNPJ – {ficha.fonte}”. Use {'{dono}'} e {'{empresa}'} na mensagem da campanha.</p>
    </div>
  );
}

function FichaView({ ficha, campanhas, onAtualizar, atualizando }: { ficha: Ficha; campanhas: Campaign[]; onAtualizar: () => void; atualizando: boolean }) {
  const [todasAtiv, setTodasAtiv] = useState(false);
  const sec = todasAtiv ? ficha.cnaesSecundarios : ficha.cnaesSecundarios.slice(0, 4);
  return (
    <div className="cnpj-ficha">
      <section className={`card stack cnpj-head ${ficha.ativa ? 'ok' : 'baixa'}`}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div className="small muted mono">{fmtCnpj(ficha.cnpj)}{ficha.matrizFilial ? ` · ${ficha.matrizFilial}` : ''}</div>
            <h2 style={{ margin: '2px 0', overflowWrap: 'anywhere' }}>{ficha.fantasia || ficha.razaoSocial}</h2>
            {ficha.fantasia && <div className="muted small" style={{ overflowWrap: 'anywhere' }}>{ficha.razaoSocial}</div>}
          </div>
          <span className={`cnpj-situacao ${ficha.ativa ? 'ok' : 'baixa'}`}>{(ficha.situacao ?? 'Situação não informada').toUpperCase()}</span>
        </div>
        {!ficha.ativa && <div className="alert err small">Empresa com situação “{ficha.situacao ?? '—'}”{ficha.dataSituacao ? ` desde ${fmtData(ficha.dataSituacao)}` : ''}{ficha.motivoSituacao ? ` (${ficha.motivoSituacao})` : ''}. Evite prospectar.</div>}
        <div className="cnpj-fatos">
          <div><span>Abertura</span><strong>{fmtData(ficha.abertura)}{idade(ficha.abertura)}</strong></div>
          <div><span>Porte</span><strong>{ficha.porte ?? '—'}</strong></div>
          <div><span>Regime</span><strong>{ficha.simples ? SIMPLES[ficha.simples] : '—'}</strong></div>
          <div><span>Natureza</span><strong>{ficha.naturezaJuridica ?? '—'}</strong></div>
        </div>
      </section>

      <div className="cnpj-grid">
        <Cartao titulo="Contato do cadastro">
          {ficha.telefones.length === 0 && !ficha.email && <p className="small muted">Sem telefone nem e-mail no cadastro.</p>}
          {ficha.telefones.map((t) => (
            <div key={t.e164} className="row between cnpj-linha">
              <span><strong>{t.exibicao}</strong> <span className="badge">{t.celular ? 'celular' : 'fixo'}</span></span>
              <span className="row">
                {t.whatsapp && <a className="btn sm primary" href={t.whatsapp} target="_blank" rel="noopener noreferrer" style={{ color: '#fff', textDecoration: 'none' }}>WhatsApp</a>}
                <a className="btn sm" href={`tel:${t.e164}`} style={{ textDecoration: 'none' }}>Ligar</a>
              </span>
            </div>
          ))}
          {ficha.email && (
            <div className="row between cnpj-linha">
              <span style={{ overflowWrap: 'anywhere' }}>{ficha.email}</span>
              <a className="btn sm" href={`mailto:${ficha.email}`} style={{ textDecoration: 'none' }}>E-mail</a>
            </div>
          )}
        </Cartao>

        <Cartao titulo="Endereço">
          <p style={{ margin: 0 }}>{ficha.enderecoTexto ?? '—'}</p>
          {ficha.mapsUrl && <a className="btn sm" href={ficha.mapsUrl} target="_blank" rel="noopener noreferrer" style={{ justifySelf: 'start', textDecoration: 'none' }}>📍 Ver no Google Maps</a>}
        </Cartao>

        <Cartao titulo="Atividade (CNAE)">
          {ficha.cnaePrincipal ? <div><span className="badge green">Principal</span> <span className="mono small">{cnae(ficha.cnaePrincipal.codigo)}</span> {ficha.cnaePrincipal.descricao}</div> : <p className="small muted">—</p>}
          {sec.map((c) => <div key={c.codigo} className="small"><span className="mono muted">{cnae(c.codigo)}</span> {c.descricao}</div>)}
          {ficha.cnaesSecundarios.length > 4 && <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setTodasAtiv((v) => !v)}>{todasAtiv ? 'Mostrar menos' : `Ver todas (${ficha.cnaesSecundarios.length} secundárias)`}</button>}
        </Cartao>

        <Cartao titulo={`Quadro de sócios${ficha.socios.length ? ` (${ficha.socios.length})` : ''}`}>
          {ficha.socios.length === 0 && <p className="small muted">A fonte não informou sócios (comum em MEI e empresário individual).</p>}
          {ficha.socios.map((s, i) => (
            <div key={i} className="cnpj-linha"><strong>{s.nome}</strong><div className="small muted">{s.qualificacao ?? 'Qualificação não informada'}{s.desde ? ` · desde ${fmtData(s.desde)}` : ''}</div></div>
          ))}
        </Cartao>
      </div>

      <Cartao titulo="Ações">
        <Acoes ficha={ficha} campanhas={campanhas} />
      </Cartao>

      <div className="row between small muted">
        <span>Fonte: {ficha.fonte} · consultado em {new Date(ficha.consultadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{ficha.doCache ? ' (guardado)' : ''}</span>
        <button className="btn ghost sm" onClick={onAtualizar} disabled={atualizando}>{atualizando ? 'Atualizando…' : '↻ Atualizar dados'}</button>
      </div>
    </div>
  );
}

function Unica({ campanhas, onUso }: { campanhas: Campaign[]; onUso: () => void }) {
  const [cnpj, setCnpj] = useState('');
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consultar = async (atualizar = false, alvo = cnpj) => {
    if (!alvo.trim()) return;
    setBusy(true); setErro(null);
    try { setFicha(await post<Ficha>('/mckmensagem/cnpj/consultar', { cnpj: alvo, atualizar })); }
    catch (e) { setErro((e as Error).message); if (!atualizar) setFicha(null); }
    finally { setBusy(false); onUso(); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); consultar(false); };
  return (
    <div className="stack">
      <form className="card cnpj-busca" onSubmit={submit}>
        <input
          inputMode="numeric" autoFocus placeholder="Digite o CNPJ (com ou sem pontos)" aria-label="CNPJ" value={cnpj}
          onChange={(e) => setCnpj(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); setCnpj(t.trim()); consultar(false, t.trim()); } }}
        />
        <button className="btn primary" disabled={busy || !cnpj.trim()}>{busy ? 'Consultando…' : 'Consultar'}</button>
      </form>
      <p className="small muted" style={{ margin: 0 }}>Busca por nome da empresa ainda não está disponível: não há fonte gratuita e confiável para isso. Consulte pelo CNPJ (ou cole vários na aba “Em lote”).</p>
      {erro && <div className="alert err">{erro}</div>}
      {ficha && <FichaView ficha={ficha} campanhas={campanhas} atualizando={busy} onAtualizar={() => consultar(true, ficha.cnpj)} />}
    </div>
  );
}

function Lote({ campanhas, onUso }: { campanhas: Campaign[]; onUso: () => void }) {
  const [texto, setTexto] = useState('');
  const [itens, setItens] = useState<ItemLote[]>([]);
  const [prog, setProg] = useState<{ feitos: number; total: number } | null>(null);
  const [tags, setTags] = useState(TAG_PADRAO);
  const [campaignId, setCampaignId] = useState('');
  const parar = useRef(false);
  const { busy, run } = useAction();
  const toast = useToast();
  const arquivo = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) { toast('Arquivo grande demais (máx. 2 MB)', 'err'); return; }
    setTexto(await f.text());
  };
  const iniciar = async () => {
    const ex = await run(() => post<{ cnpjs: string[]; invalidos: number }>('/mckmensagem/cnpj/extrair', { texto }));
    if (!ex) return;
    if (!ex.cnpjs.length) { toast('Nenhum CNPJ válido encontrado no texto', 'err'); return; }
    if (ex.invalidos) toast(`${ex.invalidos} número(s) com dígito verificador errado foram ignorados`);
    parar.current = false;
    setItens([]); setProg({ feitos: 0, total: ex.cnpjs.length });
    const acc: ItemLote[] = [];
    for (let i = 0; i < ex.cnpjs.length; i += 10) {
      if (parar.current) break;
      try {
        const r = await post<{ itens: ItemLote[] }>('/mckmensagem/cnpj/lote', { cnpjs: ex.cnpjs.slice(i, i + 10) }, { timeoutMs: 120_000 });
        acc.push(...r.itens);
        if (r.itens.some((x) => x.status === 429)) { toast(r.itens.find((x) => x.status === 429)!.erro!, 'err'); setItens([...acc]); break; }
      } catch (e) { toast((e as Error).message, 'err'); break; }
      setItens([...acc]); setProg({ feitos: Math.min(i + 10, ex.cnpjs.length), total: ex.cnpjs.length });
    }
    setProg(null); onUso();
  };
  const ok = itens.filter((x) => x.ok && x.ficha);
  const comTel = ok.filter((x) => x.ficha!.telefones.length > 0);
  const exportar = () => downloadCsv('consulta-cnpj.csv', [
    ['cnpj', 'razao_social', 'nome_fantasia', 'situacao', 'abertura', 'porte', 'cnae_principal', 'municipio', 'uf', 'endereco', 'telefone_1', 'telefone_2', 'celular', 'email', 'socio_dono', 'origem'],
    ...ok.map(({ ficha: f }) => [
      fmtCnpj(f!.cnpj), f!.razaoSocial, f!.fantasia ?? '', f!.situacao ?? '', fmtData(f!.abertura), f!.porte ?? '', f!.cnaePrincipal ? `${cnae(f!.cnaePrincipal.codigo)} ${f!.cnaePrincipal.descricao}` : '',
      f!.endereco.municipio ?? '', f!.endereco.uf ?? '', f!.enderecoTexto ?? '', f!.telefones[0]?.exibicao ?? '', f!.telefones[1]?.exibicao ?? '', f!.telefones.find((t) => t.celular)?.exibicao ?? '',
      f!.email ?? '', donoDe(f!), `Cadastro CNPJ – ${f!.fonte} – ${new Date(f!.consultadoEm).toLocaleDateString('pt-BR')}`,
    ].map(seguro)),
  ]);
  const importar = async () => {
    const r = await run(() => post<{ criados: number; atualizados: number; naFila: number; bloqueados: number; semTelefone: number; inativas: number }>('/mckmensagem/cnpj/importar', {
      itens: comTel.map((x) => ({ cnpj: x.ficha!.cnpj })), tags: parseTags(tags), campaignId: campaignId || null,
    }, { timeoutMs: 120_000 }));
    if (r) toast(`${r.criados} contato(s) novo(s), ${r.atualizados} atualizado(s)${r.naFila ? `, ${r.naFila} na fila da campanha` : ''}${r.bloqueados ? ` · ${r.bloqueados} bloqueado(s) por SAIR` : ''}`);
  };
  return (
    <div className="stack">
      <div className="card stack">
        <Field label="Cole os CNPJs (um por linha, com ou sem máscara) ou envie um CSV" hint={`Até 500 por lote. CNPJs repetidos contam uma vez.`}>
          <textarea rows={6} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'00.000.000/0001-91\n33000167000101'} />
        </Field>
        <div className="row">
          <label className="btn" style={{ cursor: 'pointer' }}>📄 Escolher CSV<input type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => arquivo(e.target.files?.[0])} /></label>
          <button className="btn primary" disabled={busy || !!prog || !texto.trim()} onClick={iniciar}>Consultar lista</button>
          {prog && <button className="btn" onClick={() => { parar.current = true; }}>Parar</button>}
        </div>
        {prog && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="small muted">Consultando {prog.feitos} de {prog.total}…</div>
            <div className="cnpj-barra"><span style={{ width: `${Math.round((prog.feitos / prog.total) * 100)}%` }} /></div>
          </div>
        )}
      </div>
      {itens.length > 0 && (
        <div className="card stack">
          <div className="row between">
            <strong>{ok.length} encontrada(s){itens.length - ok.length ? ` · ${itens.length - ok.length} com erro` : ''} · {comTel.length} com telefone</strong>
            <button className="btn sm" onClick={exportar} disabled={!ok.length}>Exportar CSV</button>
          </div>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table cnpj-tabela">
              <thead><tr><th>CNPJ</th><th>Empresa</th><th>Situação</th><th>Cidade/UF</th><th>Telefone</th><th>E-mail</th><th>Sócio/dono</th></tr></thead>
              <tbody>
                {itens.map((x) => x.ok && x.ficha ? (
                  <tr key={x.cnpj}>
                    <td className="mono small">{fmtCnpj(x.ficha.cnpj)}</td>
                    <td>{x.ficha.fantasia || x.ficha.razaoSocial}</td>
                    <td><span className={`badge ${x.ficha.ativa ? 'green' : 'red'}`}>{x.ficha.situacao ?? '—'}</span></td>
                    <td className="small">{[x.ficha.endereco.municipio, x.ficha.endereco.uf].filter(Boolean).join('/') || '—'}</td>
                    <td className="small">{x.ficha.telefones.map((t) => (
                      <div key={t.e164}>{t.whatsapp ? <a href={t.whatsapp} target="_blank" rel="noopener noreferrer">{t.exibicao}</a> : t.exibicao}{t.celular ? ' 📱' : ''}</div>
                    ))}{!x.ficha.telefones.length && '—'}</td>
                    <td className="small" style={{ overflowWrap: 'anywhere' }}>{x.ficha.email ?? '—'}</td>
                    <td className="small">{donoDe(x.ficha) || '—'}</td>
                  </tr>
                ) : (
                  <tr key={x.cnpj}><td className="mono small">{fmtCnpj(x.cnpj)}</td><td colSpan={6} className="small" style={{ color: 'var(--danger)' }}>{x.erro}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Etiqueta" hint="Separe por vírgula"><input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
            <Field label="Campanha (opcional)">
              <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">Sem campanha</option>
                {campanhas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy || !!prog || !comTel.length} onClick={importar}>Importar {fmtNum(comTel.length)} como contatos</button>
            <span className="small muted">Usa o celular do cadastro (ou o primeiro telefone). Quem já pediu para sair (SAIR) fica de fora.</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConsultaCnpj() {
  const [aba, setAba] = useState<'unica' | 'lote'>('unica');
  const uso = useApi<Uso>('/mckmensagem/cnpj/uso');
  const campanhas = useCampanhas();
  return (
    <>
      <div className="page-head">
        <div><h1>Consulta CNPJ</h1><p className="muted">Ficha da empresa em segundos e prospecção em 1 clique: adicione aos contatos ou a uma campanha.</p></div>
        {uso.data && <span className="badge blue" title={`Consultas repetidas em até ${uso.data.cacheDias} dias não contam`}>Hoje: {fmtNum(uso.data.naFonte)} de {fmtNum(uso.data.limiteDia)} consultas novas</span>}
      </div>
      <div className="stack">
        <AvisoB2B />
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={aba === 'unica'} className={aba === 'unica' ? 'on' : ''} onClick={() => setAba('unica')}>Consulta</button>
          <button role="tab" aria-selected={aba === 'lote'} className={aba === 'lote' ? 'on' : ''} onClick={() => setAba('lote')}>Em lote</button>
        </div>
        {aba === 'unica' ? <Unica campanhas={campanhas} onUso={uso.reload} /> : <Lote campanhas={campanhas} onUso={uso.reload} />}
      </div>
    </>
  );
}
