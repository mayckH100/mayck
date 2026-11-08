/**
 * Topo do app em uma linha (56 px): módulo em uso + seção atual à esquerda, ação da página e menu da conta à direita.
 * Organização, papel e nome saíram do topo e foram para o menu do avatar (pedido do dono, 08/11).
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth, ROLE_LABEL } from './auth';
import { post } from './api';
import { useToast } from './ui';
import { iniciais, type AcaoTopo, type Modulo } from './modulos';

/** Abre/fecha um menu suspenso: fecha com clique fora ou Esc e devolve o foco ao botão. */
function useSuspenso() {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => { if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAberto(false); botao.current?.focus(); } };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);
  return { aberto, setAberto, caixa, botao };
}

/** Nome do módulo + seção. Com mais de um módulo, o nome abre a lista para trocar. */
export function ModuloTitulo({ atual, secao, modulos }: { atual: Modulo; secao: string | null; modulos: Modulo[] }) {
  const m = useSuspenso();
  const texto = (
    <>
      <strong className="topo-mod-nome">{atual.label}</strong>
      {secao && secao !== atual.label && <span className="topo-secao"><span aria-hidden> · </span>{secao}</span>}
    </>
  );
  if (modulos.length < 2) return <div className="topo-mod" data-testid="topo-modulo">{texto}</div>;
  return (
    <div className="topo-mod" ref={m.caixa} data-testid="topo-modulo">
      <button ref={m.botao} type="button" className="topo-mod-btn" aria-haspopup="menu" aria-expanded={m.aberto}
        aria-label={`${atual.label}${secao && secao !== atual.label ? ` · ${secao}` : ''}. Trocar módulo`} onClick={() => m.setAberto((v) => !v)}>
        {texto}<span aria-hidden className="topo-caret">▾</span>
      </button>
      {m.aberto && (
        <div className="menu-pop menu-esq" role="menu" aria-label="Trocar módulo">
          <div className="menu-tit">Trocar módulo</div>
          {modulos.map((x) => {
            const conteudo = <><span aria-hidden className="menu-ico">{x.icon}</span>{x.label}{x.id === atual.id && <span className="menu-ok" aria-label="(atual)">✓</span>}</>;
            return x.href
              ? <a key={x.id} role="menuitem" href={x.href} onClick={() => m.setAberto(false)}>{conteudo}</a>
              : <NavLink key={x.id} role="menuitem" to={x.home} end={x.home === '/'} onClick={() => m.setAberto(false)} aria-current={x.id === atual.id ? 'page' : undefined}>{conteudo}</NavLink>;
          })}
        </div>
      )}
    </div>
  );
}

/** Ação principal da página (ex.: "+ Criar fluxo"); no celular vira só "+". */
export function AcaoDoTopo({ acao }: { acao: AcaoTopo | null }) {
  const nav = useNavigate();
  if (!acao) return null;
  return (
    <button type="button" className="btn primary sm topo-acao" aria-label={acao.label} title={acao.label} onClick={() => nav(acao.to)}>
      <span aria-hidden>+</span><span className="topo-acao-txt" aria-hidden> {acao.label}</span>
    </button>
  );
}

/** Avatar com as iniciais: organização, papel, trocar organização, perfil e sair. */
export function MenuConta() {
  const { me, setMe, logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const m = useSuspenso();
  if (!me) return null;
  const papel = me.role ? ROLE_LABEL[me.role] : '';
  const trocar = async (orgId: string) => {
    m.setAberto(false);
    if (orgId === me.org?.id) return;
    try { setMe(await post('/auth/switch-org', { orgId })); nav('/'); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="topo-conta" ref={m.caixa}>
      <button ref={m.botao} type="button" className="avatar-btn" data-sub-exempt aria-haspopup="menu" aria-expanded={m.aberto}
        aria-label={`Menu da conta: ${me.user.name}`} title={`${me.user.name} · ${me.org?.name ?? ''}`} onClick={() => m.setAberto((v) => !v)}>
        {iniciais(me.user.name)}
      </button>
      {m.aberto && (
        <div className="menu-pop" role="menu" aria-label="Conta" data-sub-exempt>
          <div className="menu-cab">
            <div className="menu-nome">{me.user.name}</div>
            <div className="small muted menu-org">{me.org?.name}</div>
            {papel && <span className="badge">{papel}</span>}
          </div>
          {me.orgs.length > 1 && (
            <>
              <div className="menu-tit">Trocar organização</div>
              {me.orgs.map((o) => (
                <button key={o.id} type="button" role="menuitem" onClick={() => trocar(o.id)} aria-current={o.id === me.org?.id ? 'true' : undefined}>
                  <span className="menu-trunc">{o.name}</span>{o.id === me.org?.id && <span className="menu-ok" aria-label="(atual)">✓</span>}
                </button>
              ))}
              <div className="menu-sep" role="separator" />
            </>
          )}
          <NavLink role="menuitem" to="/perfil" onClick={() => m.setAberto(false)}>Perfil</NavLink>
          <button type="button" role="menuitem" data-sub-exempt onClick={async () => { m.setAberto(false); await logout(); nav('/login'); }}>Sair</button>
        </div>
      )}
    </div>
  );
}
