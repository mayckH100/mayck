/**
 * v1.56.0 (Fase 1, item A4): seletor de período padrão do MCK ERP. Botões Hoje / 7 dias / 30 dias / Mês / Personalizado
 * (cada tela pode acrescentar "90 dias" ou "Todos"); as datas só aparecem no Personalizado. Cabe em 390 px.
 */
import { useState } from 'react';
import { ajustarDatas, escolherPreset, periodoInicial, PERIODOS_PADRAO, ROTULO_PERIODO, type Periodo, type PresetPeriodo } from './periodo';

export function usePeriodo(inicial: PresetPeriodo | Periodo = '30d') {
  return useState<Periodo>(() => (typeof inicial === 'string' ? periodoInicial(inicial) : inicial));
}

export function SeletorPeriodo({ valor, onChange, opcoes = PERIODOS_PADRAO, rotulo = 'Período', rotuloDatas }: {
  valor: Periodo; onChange: (p: Periodo) => void; opcoes?: PresetPeriodo[]; rotulo?: string;
  /** Texto antes das datas, ex.: "Vencimento". */
  rotuloDatas?: string;
}) {
  return (
    <div className="periodo" role="group" aria-label={rotulo} data-testid="seletor-periodo">
      <div className="periodo-opcoes">
        {opcoes.map((o) => (
          <button key={o} type="button" className={`periodo-op${valor.preset === o ? ' on' : ''}`} aria-pressed={valor.preset === o} onClick={() => onChange(escolherPreset(valor, o))}>{ROTULO_PERIODO[o]}</button>
        ))}
      </div>
      {valor.preset === 'personalizado' && (
        <div className="periodo-datas">
          <label><span>{rotuloDatas ? `${rotuloDatas} de` : 'De'}</span><input type="date" value={valor.de} max={valor.ate || undefined} onChange={(e) => onChange(ajustarDatas(valor, 'de', e.target.value))} aria-label={rotuloDatas ? `${rotuloDatas} de` : 'De'} /></label>
          <label><span>até</span><input type="date" value={valor.ate} min={valor.de || undefined} onChange={(e) => onChange(ajustarDatas(valor, 'ate', e.target.value))} aria-label={rotuloDatas ? `${rotuloDatas} até` : 'Até'} /></label>
        </div>
      )}
    </div>
  );
}
