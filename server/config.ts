import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default('http://localhost:5173'),
  MASTER_KEY: z.string().optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  LOGIN_RATE_LIMIT: z.coerce.number().default(10),
  API_RATE_LIMIT: z.coerce.number().default(300),
  WEBHOOK_RATE_LIMIT: z.coerce.number().default(600),
  ALLOW_PRIVATE_HTTP: z.enum(['true', 'false']).default('false'),
  GRAPH_API_VERSION: z.string().default('v26.0'),
  GRAPH_API_BASE: z.string().default('https://graph.facebook.com'),
  ENABLE_SCHEDULER: z.enum(['true', 'false']).default('true'),
  ENABLE_WHATSAPP_QR: z.enum(['true', 'false']).default('true'),
  FLOW_MAX_STEPS: z.coerce.number().default(50),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const cfg = schema.parse(process.env);
  if (cfg.NODE_ENV === 'production' && !cfg.MASTER_KEY) {
    throw new Error('MASTER_KEY é obrigatória em produção (32 bytes em base64). Gere com: openssl rand -base64 32');
  }
  return cfg;
}

export const config = loadConfig();
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
