import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { VERSAO, CHANGELOG } from './versaoInfo';

/** Número da versão no fim do menu / tela de entrada; abre o histórico de versões. */
export function VersaoRodape({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <Link to="/versoes" className={`versao-rodape ${className}`} style={style} data-sub-exempt title="Ver novidades e histórico de versões" data-testid="versao-rodape">
      {VERSAO.rotulo}
    </Link>
  );
}

/** Página "Novidades e histórico de versões" (logado ou não). */
export function Versoes({ standalone = false }: { standalone?: boolean }) {
  const nav = useNavigate();
  const corpo = (
    <div className="stack versoes" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1 style={{ margin: 0 }}>Novidades e histórico de versões</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Você está usando a <strong>{VERSAO.rotulo}</strong>.</p>
        </div>
        <button type="button" className="btn sm" data-sub-exempt onClick={() => (window.history.length > 1 ? nav(-1) : nav('/'))}>← Voltar</button>
      </div>
      {CHANGELOG.map((e, i) => (
        <section key={e.versao} className="card stack" id={`v${e.versao}`} aria-labelledby={`vt-${e.versao}`}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h2 id={`vt-${e.versao}`} style={{ margin: 0, fontSize: 18 }}>
              Versão {e.versao} {i === 0 && <span className="badge">Atual</span>}
            </h2>
            <span className="small muted">{e.data}</span>
          </div>
          <strong>{e.titulo}</strong>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            {e.itens.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
  if (!standalone) return corpo;
  return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>{corpo}</div>;
}

export default Versoes;
