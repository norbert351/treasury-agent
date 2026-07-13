import { pgTable, uuid, text, timestamp, bigint, jsonb } from 'drizzle-orm/pg-core';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const rules = pgTable('rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type', { enum: ['recurring', 'threshold', 'auto-invest'] }).notNull(),
  name: text('name').notNull(),
  active: text('active', { enum: ['true', 'false'] }).default('true').notNull(),

  // Recurring: cron expression
  cron: text('cron'),
  // Recipient nametag or address
  recipient: text('recipient'),
  // Amount in UCT (smallest unit)
  amount: text('amount'),

  // Threshold: minimum balance before alert
  minBalance: text('min_balance'),

  // Auto-invest: target to swap excess into
  targetCoin: text('target_coin'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  lastRunAt: timestamp('last_run_at'),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleId: uuid('rule_id').references(() => rules.id),
  type: text('type', { enum: ['send', 'receive', 'swap', 'alert'] }).notNull(),
  amount: text('amount').notNull(),
  coinId: text('coin_id').default('UCT').notNull(),
  counterparty: text('counterparty'),
  status: text('status', { enum: ['pending', 'confirmed', 'failed'] }).default('pending').notNull(),
  txHash: text('tx_hash'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type', { enum: ['low_balance', 'payment_sent', 'payment_received', 'error', 'report'] }).notNull(),
  message: text('message').notNull(),
  sentVia: text('sent_via', { enum: ['dm', 'dashboard'] }).default('dashboard').notNull(),
  read: text('read', { enum: ['true', 'false'] }).default('false').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
