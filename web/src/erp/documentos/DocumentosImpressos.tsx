/**
 * v1.54.0 — MCK ERP › Documentos impressos (só Proprietário/Administrador): logo e dados que saem no cabeçalho de todos
 * os documentos (pedido, orçamento, romaneio, recibo, ordem de compra, OP, financeiro, inventário, fechamento de caixa,
 * relatórios, listas e fichas de cadastro). v1.55.0: escolha da posição do logo (Esquerda/Centro) com prévia.
 * O rodapé da MCK é fixo e aparece só como informação (não há campo para mudar).
 */
import { useMemo, useState } from 'react';
import { put } from '../../api';
import { useAuth } from '../../auth';
import { useApi, Async, Field, useAction, useToast } from '../../ui';
import { CAMPOS_CABECALHO, LOGO_MAX_BYTES, RODAPE_DOCUMENTO, posicaoLogoValida, type ConfigDocumento, type PosicaoLogo } from '../../../../server/erp/shared/documento';
import { paginaHtml } from '../impressao/modelo';
import { limparCacheDocumento } from '../impressao/cabecalho';

const ROTULO: Record<(typeof CAMPOS_CABECALHO)[number], string> = {
  nomeExibicao: 'Nome que aparece no documento', cnpj: 'CNPJ', ie: 'Inscrição estadual', logradouro: 'Endereço (rua, avenida)', numero: 'Número',
  bairro: 'Bairro', cidade: 'Cidade', uf: 'UF', cep: 'CEP', telefone: 'Telefone', whatsapp: 'WhatsApp', email: 'E-mail', site: 'Site', textoLivre: 'Texto livre (ex.: condições, horário)',
};

/** Reduz o logo no navegador (máx. 800×400 px) e devolve data URL PNG/JPEG/WEBP. Nunca SVG. */
async function prepararLogo(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem PNG, JPG ou WEBP');
  if (file.size > 8 * 1024 * 1024) throw new Error('Imagem muito grande (máx. 8 MB antes de reduzir)');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => erro(new Error('Não foi possível ler a imagem')); i.src = url; });
    const k = Math.min(1, 800 / img.naturalWidth, 400 / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    // PNG mantém o fundo transparente; se passar do limite, tenta WEBP e depois JPEG com fundo branco.
    let out = c.toDataURL('image/png');
    const bytes = (d: string) => Math.floor(((d.length - d.indexOf(',') - 1) * 3) / 4);
    if (bytes(out) > LOGO_MAX_BYTES) {
      out = c.toDataURL('image/webp', 0.9); // navegador sem WEBP devolve PNG: cai no JPEG abaixo
    }
    if (bytes(out) > LOGO_MAX_BYTES) {
      const ctx = c.getContext('2d')!; ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', 0.85);
    }
    if (bytes(out) > LOGO_MAX_BYTES) throw new Error('Logo muito grande mesmo depois de reduzir: o máximo é 500 KB');
    return out;
  } finally { URL.revokeObjectURL(url); }
}

export default function DocumentosImpressos() {
  const st = useApi<any>('/erp/documentos/config');
  const { can } = useAuth();
  return (
    <div className="page">
      <div className="page-head"><div><h1>Documentos impressos</h1><p className="muted">Seu logo e os dados da empresa no topo de pedidos, orçamentos, romaneios, recibos, ordens de compra e de produção, comprovantes do financeiro, folhas de inventário, relatórios, listas e PDFs exportados.</p></div></div>
      {!can('OWNER', 'ADMIN') ? <div className="card"><p className="small">Só o proprietário ou um administrador altera os documentos impressos.</p></div>
        : <Async state={st}>{(d) => <Form inicial={d} onSaved={st.reload} />}</Async>}
    </div>
  );
}

function Form({ inicial, onSaved }: { inicial: { config: ConfigDocumento; salvo: boolean }; onSaved: () => void }) {
  const [f, setF] = useState<ConfigDocumento>(inicial.config);
  const [logoNovo, setLogoNovo] = useState<string | null | undefined>(undefined); // undefined = sem mudança
  const { busy, run } = useAction(); const toast = useToast();
  const logo = logoNovo === undefined ? f.logo : logoNovo;
  const set = (k: keyof ConfigDocumento) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const posicao = posicaoLogoValida(f.posicaoLogo);
  // v1.55.0: a prévia mostra o layout escolhido (logo à esquerda ou no centro).
  const previa = useMemo(() => paginaHtml({
    titulo: 'Pedido de venda nº 123', subtitulo: 'Emitido em 26/11/2026 10:30', config: { ...f, logo, posicaoLogo: posicao },
    corpo: '<div class="small">Exemplo de como o topo e o rodapé saem no papel.</div><table><thead><tr><th>Item</th><th>Qtd</th><th class="dir">Total</th></tr></thead><tbody><tr><td>Produto exemplo</td><td>1 UN</td><td class="dir">R$ 10,00</td></tr></tbody></table>',
  }), [f, logo, posicao]);
  async function escolher(file?: File) {
    if (!file) return;
    try { setLogoNovo(await prepararLogo(file)); } catch (e) { toast((e as Error).message, 'err'); }
  }
  const salvar = async () => {
    const corpo: Record<string, unknown> = {};
    for (const k of CAMPOS_CABECALHO) corpo[k] = f[k] ?? '';
    corpo.posicaoLogo = posicao;
    if (logoNovo !== undefined) corpo.logo = logoNovo;
    const r = await run(() => put<any>('/erp/documentos/config', corpo), 'Documentos impressos salvos');
    if (r) { limparCacheDocumento(r.config); setLogoNovo(undefined); setF(r.config); onSaved(); }
  };
  return (
    <>
      {!inicial.salvo && <div className="card small" style={{ marginBottom: 10 }}>Preenchemos com os dados do emitente (Fiscal) e o nome da empresa. Confira e salve.</div>}
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Logo</h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {logo ? <img src={logo} alt="Logo atual" style={{ maxWidth: 160, maxHeight: 80, objectFit: 'contain', border: '1px solid #e5e7eb', padding: 4, background: '#fff' }} /> : <span className="small muted">Sem logo</span>}
            <label className="btn sm">{logo ? 'Trocar logo' : 'Enviar logo'}<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { escolher(e.target.files?.[0]); e.target.value = ''; }} /></label>
            {logo && <button className="btn sm ghost" onClick={() => setLogoNovo(null)}>Remover</button>}
          </div>
          <p className="small muted">PNG, JPG ou WEBP. Reduzimos para até 800×400 px (máx. 500 KB). Fundo transparente ou branco fica melhor.</p>
          <Field label="Posição do logo" hint="Esquerda: logo no canto e os dados embaixo, em letra pequena. Centro: logo e dados centralizados. O recibo de 80 mm sai sempre centralizado.">
            <select value={posicao} onChange={(e) => setF({ ...f, posicaoLogo: e.target.value as PosicaoLogo })} aria-label="Posição do logo">
              <option value="ESQUERDA">Esquerda (padrão)</option>
              <option value="CENTRO">Centro</option>
            </select>
          </Field>
          <h3>Dados do cabeçalho</h3>
          <Field label={ROTULO.nomeExibicao}><input value={f.nomeExibicao} onChange={set('nomeExibicao')} maxLength={120} /></Field>
          <div className="grid g2">
            <Field label={ROTULO.cnpj}><input value={f.cnpj} onChange={set('cnpj')} maxLength={20} inputMode="numeric" /></Field>
            <Field label={ROTULO.ie}><input value={f.ie} onChange={set('ie')} maxLength={20} /></Field>
          </div>
          <Field label={ROTULO.logradouro}><input value={f.logradouro} onChange={set('logradouro')} maxLength={120} /></Field>
          <div className="grid g2">
            <Field label={ROTULO.numero}><input value={f.numero} onChange={set('numero')} maxLength={20} /></Field>
            <Field label={ROTULO.bairro}><input value={f.bairro} onChange={set('bairro')} maxLength={80} /></Field>
            <Field label={ROTULO.cidade}><input value={f.cidade} onChange={set('cidade')} maxLength={80} /></Field>
            <Field label={ROTULO.uf}><input value={f.uf} onChange={set('uf')} maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
            <Field label={ROTULO.cep}><input value={f.cep} onChange={set('cep')} maxLength={10} inputMode="numeric" /></Field>
            <Field label={ROTULO.telefone}><input value={f.telefone} onChange={set('telefone')} maxLength={20} inputMode="tel" /></Field>
            <Field label={ROTULO.whatsapp}><input value={f.whatsapp} onChange={set('whatsapp')} maxLength={20} inputMode="tel" /></Field>
            <Field label={ROTULO.email}><input value={f.email} onChange={set('email')} maxLength={120} type="email" /></Field>
          </div>
          <Field label={ROTULO.site}><input value={f.site} onChange={set('site')} maxLength={120} placeholder="www.suaempresa.com.br" /></Field>
          <Field label={ROTULO.textoLivre} hint="Até 300 caracteres"><textarea value={f.textoLivre} onChange={set('textoLivre')} maxLength={300} rows={2} /></Field>
          <Field label="Rodapé (fixo)"><div className="small muted" style={{ padding: '6px 0' }}>{RODAPE_DOCUMENTO}</div></Field>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={salvar}>Salvar</button></div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Prévia</h3>
          <iframe title="Prévia do documento" sandbox="" srcDoc={previa} style={{ width: '100%', height: 360, border: '1px solid #e5e7eb', background: '#fff' }} />
          <p className="small muted">O rodapé com o MCK ERP sai em todos os documentos e não pode ser alterado.</p>
        </div>
      </div>
    </>
  );
}
