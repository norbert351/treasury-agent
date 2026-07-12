import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  UNICITY_API_KEY: z.string().min(1, 'UNICITY_API_KEY is required'),
  UNICITY_NETWORK: z.string().default('testnet2'),
  AGENT_MNEMONIC: z.string().optional(),
  AGENT_NAMETAG: z.string().default('treasury_bot'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/treasury'),
  PORT: z.coerce.number().default(3001),
  DASHBOARD_URL: z.string().default('http://localhost:3001'),
  USER_NAMETAG: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
