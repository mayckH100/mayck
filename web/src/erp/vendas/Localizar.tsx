/**
 * Localizar pedido (v1.34.0): leia o QR/código de barras do pedido impresso, do recibo, do romaneio, da etiqueta do
 * lote, do produto ou a chave do DANFE (44 dígitos) — ou digite nº do pedido, nº da nota, cliente, lote ou produto.
 */
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, Async, Empty, fmtDate, useToast } from '../../ui';
import { brl } from '../format';
import { badgeStatus } from './Pedidos';
import { CampoLeitura } from '../leitura/Leitor';
import { imprimirDocumento } from './documento';
import { BotaoImprimir } from '../impressao/BotaoPdf';
import { listaLocalizar } from '../impressao/cadastros';
import { STATUS_PEDIDO } from '../format';

export default function Localizar() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const st = useApi<any>(q ? `/erp/vendas/localizar?q=${encodeURIComponent(q)}` : null, [q]);
  const nav = useNavigate(); const toast = useToast();
  return (
    <>
      <div className="page-head"><div><h1>Localizar pedido</h1><p className="muted">Leia o código do pedido/recibo/romaneio, da etiqueta do lote, do produto ou da nota (DANFE) — ou digite nº do pedido, nota, cliente, lote ou produto.</p></div></div>
      <div className="card" style={{ marginBottom: 12 }}>
        <CampoLeitura continuo={false} placeholder="Ex.: PV-15, 15, chave da NF-e, Padaria, L2611-0001, 789…" rotuloOk="Procurar" dicaCamera="Aponte para o QR/código do pedido, da etiqueta ou do DANFE."
          onCodigo={(c) => { setSp({ q: c.trim() }); }} />
      </div>
      {q && <Async state={st}>{(d) => d.pedidos.length === 0 ? <div className="card"><Empty title="Nenhum pedido encontrado">Nada com “{q.slice(0, 60)}”. Confira o código ou procure pelo nome do cliente.</Empty></div> : (
        <>
          <div className="row between"><p className="small muted">{d.total} pedido{d.total === 1 ? '' : 's'} encontrado{d.total === 1 ? '' : 's'}</p><BotaoImprimir className="btn sm" montar={() => listaLocalizar(d, q, STATUS_PEDIDO)} /></div>
          {d.pedidos.map((p: any) => (
            <div key={p.id} className="card" style={{ padding: 12, marginBottom: 8 }} data-testid="pedido-achado">
              <div className="row between" style={{ gap: 6 }}>
                <div><b style={{ fontSize: 17 }}>Pedido nº {p.numero}</b> {badgeStatus(p.status)}{p.balcao && <span className="badge" style={{ marginLeft: 4 }}>Balcão</span>}
                  <div className="small">{p.cliente} · {fmtDate(p.createdAt)} · <b>{brl(p.totalCents)}</b>{p.nf ? ` · ${p.nf}` : ''}</div>
                  <div className="small muted">Encontrado por: {p.motivos.join('; ')}</div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm primary" onClick={() => nav(`/erp/pedidos/${p.id}`)}>Abrir</button>
                  <button className="btn sm" onClick={() => nav(`/erp/rastreio?pedido=${p.id}`)}>Lotes</button>
                  <button className="btn sm" onClick={() => imprimirDocumento(p.balcao ? 'recibo' : 'pedido', p.id).catch((e) => toast((e as Error).message, 'err'))}>Imprimir</button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}</Async>}
    </>
  );
}
