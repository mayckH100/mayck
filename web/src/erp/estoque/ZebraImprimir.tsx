/**
 * Botão "Imprimir na Zebra" (v1.34.0): imprime direto na impressora guardada neste aparelho (Bluetooth, USB ou
 * Zebra Browser Print). Sem impressora ou com erro, abre "Localizar impressora" com o status e o que fazer; o
 * download do .zpl só aparece no fim, como último recurso e explicando o porquê.
 */
import { useState } from 'react';
import { Modal, useToast } from '../../ui';
import {
  impressoraSalva, esquecerImpressora, imprimirNaSalva, tentarBrowserPrintPadrao, localizarBluetooth, localizarUsb, listarBrowserPrint,
  escolherBrowserPrint, baixarZpl, suporte, ErroZebra, ZPL_TESTE, type ImpressoraSalva, type Status,
} from './zebra';

const ROT: Record<Status, string> = { procurando: 'Procurando impressora…', conectando: 'Conectando…', conectada: 'Conectada', imprimindo: 'Imprimindo…', impresso: 'Enviado para a impressora ✔', erro: 'Erro' };
const NOME_CONEXAO = { bluetooth: 'Bluetooth', usb: 'USB', browserprint: 'Zebra Browser Print' } as const;

export function BotaoZebra({ obterZpl, rotulo = 'Imprimir na Zebra', className = 'btn', disabled }: { obterZpl: () => Promise<string>; rotulo?: string; className?: string; disabled?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [modal, setModal] = useState<{ zpl: string; erro?: ErroZebra } | null>(null);
  const toast = useToast();
  const salva = impressoraSalva();
  async function clicar() {
    let zpl: string;
    try { zpl = await obterZpl(); } catch (e) { toast((e as Error).message, 'err'); return; }
    try {
      let imp = impressoraSalva();
      if (!imp) { setStatus('procurando'); imp = await tentarBrowserPrintPadrao(); }
      if (!imp) { setStatus(null); setModal({ zpl }); return; }
      const i = await imprimirNaSalva(zpl, setStatus);
      toast(`Etiquetas enviadas para ${i.nome}`);
      setTimeout(() => setStatus(null), 2500);
    } catch (e) {
      setStatus('erro');
      setModal({ zpl, erro: e instanceof ErroZebra ? e : new ErroZebra((e as Error).message, 'Toque em Localizar impressora e tente de novo.') });
    }
  }
  return (
    <>
      <button type="button" className={className} disabled={disabled || status === 'imprimindo' || status === 'conectando' || status === 'procurando'} onClick={clicar} title={salva ? `Impressora: ${salva.nome} (${NOME_CONEXAO[salva.conexao]})` : 'Imprimir direto na Zebra'}>
        🖨️ {status && status !== 'erro' ? ROT[status] : rotulo}
      </button>
      {modal && <LocalizarImpressora zpl={modal.zpl} erro={modal.erro} onClose={() => { setModal(null); setStatus(null); }} />}
    </>
  );
}

/** "Localizar impressora": escolhe a conexão, pareia, guarda neste aparelho e (com zpl) já imprime. */
export function LocalizarImpressora({ zpl, erro: erroInicial, onClose }: { zpl?: string; erro?: ErroZebra; onClose: () => void }) {
  const [imp, setImp] = useState<ImpressoraSalva | null>(impressoraSalva());
  const [status, setStatus] = useState<Status | null>(erroInicial ? 'erro' : null);
  const [erro, setErro] = useState<ErroZebra | null>(erroInicial ?? null);
  const [bp, setBp] = useState<Record<string, unknown>[] | null>(null);
  const [verBaixar, setVerBaixar] = useState(false);
  const s = suporte();
  const toast = useToast();
  async function tentar(fn: () => Promise<ImpressoraSalva | null>) {
    setErro(null); setStatus('procurando');
    try {
      const i = await fn(); if (!i) { setStatus(null); return; }
      setImp(i); setStatus('conectada');
      if (zpl) { await imprimirNaSalva(zpl, setStatus); toast(`Etiquetas enviadas para ${i.nome}`); onClose(); }
    } catch (e) { setStatus('erro'); setErro(e instanceof ErroZebra ? e : new ErroZebra((e as Error).message, 'Tente outra forma de conexão abaixo.')); }
  }
  return (
    <Modal title="Impressora Zebra" onClose={onClose}>
      <div className="card" style={{ padding: 10, marginBottom: 8 }} role="status">
        {imp ? <div className="row between" style={{ gap: 6 }}><span>Impressora deste aparelho: <b>{imp.nome}</b> · {NOME_CONEXAO[imp.conexao]}{status && ` · ${ROT[status]}`}</span>
          <span className="row" style={{ gap: 4 }}><button className="btn sm" onClick={() => tentar(async () => { await imprimirNaSalva(ZPL_TESTE, setStatus); return impressoraSalva(); })}>Teste</button><button className="btn ghost sm" onClick={() => { esquecerImpressora(); setImp(null); setStatus(null); }}>Esquecer</button></span></div>
          : <span>Nenhuma impressora escolhida neste aparelho.{status && status !== 'erro' ? ` ${ROT[status]}` : ''}</span>}
      </div>
      {erro && !erro.cancelado && <div className="card" style={{ padding: 10, marginBottom: 8, borderColor: '#dc2626' }} role="alert"><b style={{ color: '#dc2626' }}>{erro.message}</b><div className="small">O que fazer: {erro.oQueFazer}</div></div>}
      {erro?.cancelado && <p className="small muted">{erro.message} {erro.oQueFazer}</p>}
      <p className="small" style={{ marginTop: 0 }}><b>Localizar impressora</b> (a escolha fica guardada neste aparelho):</p>
      <div style={{ display: 'grid', gap: 6 }}>
        <button className="btn primary" disabled={!s.bluetooth || status === 'procurando'} onClick={() => tentar(() => localizarBluetooth())}>📶 Bluetooth (celular Android com Chrome)</button>
        {s.bluetooth && <button className="btn ghost sm" disabled={status === 'procurando'} onClick={() => tentar(() => localizarBluetooth(true))}>Não apareceu? Mostrar todos os aparelhos Bluetooth</button>}
        <button className="btn" disabled={!s.usb || status === 'procurando'} onClick={() => tentar(localizarUsb)}>🔌 USB (computador com Chrome/Edge)</button>
        <button className="btn" disabled={status === 'procurando'} onClick={async () => { setErro(null); setStatus('procurando'); try { setBp(await listarBrowserPrint()); setStatus(null); } catch (e) { setStatus('erro'); setErro(e as ErroZebra); } }}>🖥️ Zebra Browser Print (USB ou rede/IP no computador)</button>
        {bp && (bp.length ? bp.map((d, k) => <button key={k} className="btn sm" onClick={() => tentar(() => escolherBrowserPrint(d))}>{String(d.name ?? 'Zebra')} · {String(d.connection ?? '')}</button>) : <p className="small">O Browser Print está aberto, mas não vê nenhuma impressora. Ligue a impressora ou adicione a de rede (IP) nele.</p>)}
      </div>
      {!s.bluetooth && <p className="small muted">{s.iphone ? 'iPhone/iPad: o Safari não libera Bluetooth nem USB para sites. Imprima por um computador com o Zebra Browser Print ou por um celular Android.' : 'Bluetooth para sites: só no Chrome (Android, Windows, Mac).'}</p>}
      <p className="small muted">Impressora de rede (IP): o navegador não envia direto para o IP da impressora; adicione-a no Zebra Browser Print e escolha acima.</p>
      {zpl && <div style={{ marginTop: 8 }}>
        {!verBaixar ? <button className="btn ghost sm" onClick={() => setVerBaixar(true)}>Nenhuma forma funcionou?</button> : <div className="card" style={{ padding: 10 }}>
          <p className="small" style={{ marginTop: 0 }}>Último recurso: baixar o arquivo <b>.zpl</b> e mandar para a Zebra pelo programa da Zebra (Zebra Setup Utilities) ou copiando para a impressora. Use só se nenhuma conexão acima funcionou{erro ? ` (motivo: ${erro.message})` : ''}.</p>
          <button className="btn sm" onClick={() => { baixarZpl(zpl); onClose(); }}>Baixar arquivo .zpl</button>
        </div>}
      </div>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}><button className="btn" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
