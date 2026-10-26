import { useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useApi, Async } from './ui';

type Info = {
  app: string; product: string; allowed: boolean; reason: string; title: string | null; duration: number | null;
  chapters: { title: string; start: number }[]; available: boolean;
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const REASON: Record<string, string> = {
  teste_gratis: 'Você está no período de teste grátis. Os tutoriais em vídeo são liberados assim que a assinatura paga é ativada.',
  vencida: 'Sua assinatura está vencida. Renove para voltar a assistir aos tutoriais.',
  bloqueada: 'Sua assinatura está bloqueada. Regularize para voltar a assistir aos tutoriais.',
  sem_plano: 'Os tutoriais em vídeo fazem parte da assinatura paga.',
};

/** Página "Tutoriais": player com capítulos clicáveis e legendas. Vídeo servido por rota autenticada (só assinantes). */
export default function Tutorials({ app, appName, planPath }: { app: 'mckbot' | 'mck-mensagens'; appName: string; planPath: string }) {
  const state = useApi<Info>(`/tutorials/${app}`);
  const video = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(0);
  return (
    <>
      <div className="page-head">
        <div><h1>Tutoriais</h1><p className="muted">Aprenda a usar cada parte do {appName}, passo a passo, com narração e legendas.</p></div>
      </div>
      <Async state={state}>{(t) => {
        const chapters = t.chapters ?? [];
        const active = chapters.reduce((acc, c, i) => (current >= c.start ? i : acc), 0);
        if (!t.allowed) {
          return (
            <div className="card stack tut-locked" style={{ textAlign: 'center', alignItems: 'center', padding: 32 }}>
              <div style={{ fontSize: 40 }} aria-hidden>🔒</div>
              <h2 style={{ margin: 0 }}>Disponível para assinantes</h2>
              <p className="muted" style={{ maxWidth: 520, margin: 0 }}>{REASON[t.reason] ?? REASON.sem_plano}</p>
              {chapters.length > 0 && <p className="small muted" style={{ margin: 0 }}>O vídeo{t.duration ? ` (${fmt(t.duration)})` : ''} cobre: {chapters.map((c) => c.title).join(' · ')}.</p>}
              <NavLink to={planPath} className="btn primary" style={{ color: '#fff', textDecoration: 'none' }}>Assinar agora</NavLink>
            </div>
          );
        }
        if (!t.available) return <div className="card"><p className="muted">O vídeo tutorial está sendo preparado. Volte em breve.</p></div>;
        return (
          <div className="tut-grid" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 3fr) minmax(220px, 1fr)', alignItems: 'start' }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden', background: '#000' }}>
              <video
                ref={video} controls playsInline preload="metadata"
                controlsList="nodownload" onContextMenu={(e) => e.preventDefault()}
                style={{ width: '100%', display: 'block', aspectRatio: '16 / 9', background: '#000' }}
                onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
                src={`/api/tutorials/${app}/video`}
              >
                <track kind="subtitles" srcLang="pt-BR" label="Português (Brasil)" src={`/api/tutorials/${app}/captions.vtt`} default />
              </video>
            </div>
            <div className="card stack" style={{ gap: 4 }}>
              <strong>Capítulos</strong>
              <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 2 }} aria-label="Capítulos do vídeo">
                {chapters.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button" className={`btn sm ${i === active ? 'primary' : ''}`}
                      style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', display: 'flex', gap: 8 }}
                      onClick={() => { const v = video.current; if (v) { v.currentTime = c.start; void v.play(); } }}
                    >
                      <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{fmt(c.start)}</span><span>{c.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {t.duration && <p className="small muted" style={{ margin: '8px 0 0' }}>Duração total: {fmt(t.duration)}. Legendas em português: botão CC do player.</p>}
            </div>
          </div>
        );
      }}</Async>
    </>
  );
}
