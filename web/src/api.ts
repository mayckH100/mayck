let csrfToken = '';
export const setCsrf = (t: string) => { csrfToken = t; };

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); }
}

const FRIENDLY: Record<number, string> = {
  402: 'Sua assinatura está inativa. Regularize em Plano para continuar usando este recurso.',
  403: 'Você não tem permissão para acessar este recurso.',
  404: 'Não encontrado.',
  429: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  500: 'Erro interno do servidor. Tente novamente em instantes.',
  502: 'O serviço externo não respondeu. Tente novamente em instantes.',
  503: 'Serviço indisponível no momento.',
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['x-requested-with'] = 'mckbot';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('mck:unauthorized'));
    // 402 = assinatura inativa (vencida/bloqueada): avisa o app para mostrar o banner e levar à Assinatura.
    if (res.status === 402) window.dispatchEvent(new CustomEvent('mck:payment-required', { detail: data?.error ?? null }));
    const details = data?.details;
    let msg = data?.error ?? FRIENDLY[res.status] ?? `Erro ${res.status}`;
    if (Array.isArray(details) && details.length) msg += ': ' + details.join('; ');
    else if (details?.fieldErrors) {
      const f = Object.entries(details.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(', ')}`);
      if (f.length) msg += ' — ' + f.join(' | ');
    }
    throw new ApiError(msg, res.status, details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Upload binário (arquivo inteiro no corpo; nome em x-file-name). Usado pelos anexos/boletos/comprovantes do MCK Mensagens. */
export async function upload<T = any>(path: string, file: File | Blob, name?: string): Promise<T> {
  const fileName = name ?? (file as File).name ?? 'arquivo';
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { 'x-requested-with': 'mckbot', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(fileName) },
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 402) window.dispatchEvent(new CustomEvent('mck:payment-required', { detail: data?.error ?? null }));
    throw new ApiError(data?.error ?? FRIENDLY[res.status] ?? `Erro ${res.status}`, res.status, data?.details);
  }
  return data as T;
}
