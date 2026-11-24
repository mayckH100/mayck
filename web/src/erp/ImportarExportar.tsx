/** Botões de planilha: baixar modelo, exportar e importar (com conferência antes de gravar). */
import { useRef, useState } from 'react';
import { upload } from '../api';
import { Modal, useAction } from '../ui';

const NOME: Record<string, string> = { clientes: 'clientes', fornecedores: 'fornecedores', produtos: 'produtos' };

export default function ImportarExportar({ entidade, onImportado, podeImportar = true }: { entidade: 'clientes' | 'fornecedores' | 'produtos'; onImportado?: () => void; podeImportar?: boolean }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <a className="btn" href={`/api/erp/io/${entidade}/exportar`} download>Exportar</a>
      {podeImportar && <button className="btn" onClick={() => setAberto(true)}>Importar</button>}
      {aberto && <Importar entidade={entidade} onClose={() => setAberto(false)} onDone={() => { setAberto(false); onImportado?.(); }} />}
    </>
  );
}

function Importar({ entidade, onClose, onDone }: { entidade: string; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [arq, setArq] = useState<File | null>(null);
  const [previa, setPrevia] = useState<any>(null);
  const { busy, run } = useAction();
  const conferir = async (f: File) => { setArq(f); setPrevia(null); const r = await run(() => upload<any>(`/erp/io/${entidade}/importar?simular=1`, f)); if (r) setPrevia(r); };
  return (
    <Modal title={`Importar ${NOME[entidade]}`} onClose={onClose}>
      <ol className="small" style={{ paddingLeft: 18, marginTop: 0 }}>
        <li>Baixe o modelo e preencha a partir da 2ª linha (colunas com * são obrigatórias). Pode apagar as linhas de exemplo.</li>
        <li>No Excel ou Google Planilhas: Arquivo → Salvar como / Fazer download → <b>CSV</b>.</li>
        <li>Envie o arquivo: mostramos o que entra e os erros antes de gravar. Quem já existe é atualizado{entidade === 'produtos' ? ' pelo SKU' : ' pelo CPF/CNPJ'}.</li>
      </ol>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <a className="btn" href={`/api/erp/io/${entidade}/modelo`} download>Baixar modelo</a>
        <button className="btn primary" disabled={busy} onClick={() => ref.current?.click()}>{arq ? 'Trocar arquivo' : 'Escolher planilha (.csv)'}</button>
        <input ref={ref} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) conferir(f); e.target.value = ''; }} />
      </div>
      {previa && (
        <div className="card" style={{ background: 'transparent' }}>
          <p><b>{previa.validos}</b> de {previa.total} linha(s) prontas: {previa.novos} nova(s), {previa.atualizados} atualização(ões).{previa.qtdErros ? <> <b style={{ color: '#dc2626' }}>{previa.qtdErros} com erro</b> (ficam de fora).</> : ''}</p>
          {previa.erros.length > 0 && <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}><table><thead><tr><th>Linha</th><th>Erro</th></tr></thead><tbody>{previa.erros.map((e: any) => <tr key={e.linha}><td>{e.linha}</td><td className="small">{e.erro}</td></tr>)}</tbody></table></div>}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !previa.validos} onClick={async () => { if (arq && await run(() => upload<any>(`/erp/io/${entidade}/importar`, arq), `${previa.validos} cadastro(s) importado(s)`)) onDone(); }}>Importar {previa.validos} linha(s)</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
