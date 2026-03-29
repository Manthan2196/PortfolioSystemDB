-- ═══════════════════════════════════════════════════════════
-- TradeFlow — PostgreSQL Schema
-- Run this once to set up all tables, indexes, and seed data
-- ═══════════════════════════════════════════════════════════

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email      TEXT        UNIQUE NOT NULL,
  password   TEXT        NOT NULL,                    -- bcrypt hash
  name       TEXT        NOT NULL,
  role       TEXT        NOT NULL DEFAULT 'USER'      -- 'USER' | 'ADMIN'
                         CHECK (role IN ('USER','ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Wallet ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

-- ── Stocks ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stocks (
  id         SERIAL      PRIMARY KEY,
  symbol     TEXT        UNIQUE NOT NULL,
  name       TEXT        NOT NULL,
  sector     TEXT        NOT NULL,
  price      NUMERIC(18,2) NOT NULL,
  prev_price NUMERIC(18,2) NOT NULL,
  market_cap TEXT,
  volume     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Stock Price History ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_price_history (
  id         BIGSERIAL   PRIMARY KEY,
  stock_id   INT         NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
  price      NUMERIC(18,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sph_stock_time ON stock_price_history(stock_id, recorded_at DESC);

-- ── Orders ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id   INT         NOT NULL REFERENCES stocks(id),
  symbol     TEXT        NOT NULL,
  order_type TEXT        NOT NULL CHECK (order_type IN ('BUY','SELL')),
  price_type TEXT        NOT NULL DEFAULT 'MARKET' CHECK (price_type IN ('MARKET','LIMIT','SL')),
  qty        INT         NOT NULL CHECK (qty > 0),
  price      NUMERIC(18,2) NOT NULL CHECK (price > 0),
  total      NUMERIC(18,2) NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','EXECUTED','CANCELLED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

-- ── Trades ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID        NOT NULL REFERENCES orders(id),
  user_id     UUID        NOT NULL REFERENCES users(id),
  stock_id    INT         NOT NULL REFERENCES stocks(id),
  symbol      TEXT        NOT NULL,
  trade_type  TEXT        NOT NULL CHECK (trade_type IN ('BUY','SELL')),
  qty         INT         NOT NULL,
  price       NUMERIC(18,2) NOT NULL,
  total       NUMERIC(18,2) NOT NULL,
  pnl         NUMERIC(18,2) DEFAULT 0,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, executed_at DESC);

-- ── Portfolio ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_id    INT         NOT NULL REFERENCES stocks(id),
  symbol      TEXT        NOT NULL,
  qty         INT         NOT NULL DEFAULT 0 CHECK (qty >= 0),
  avg_price   NUMERIC(18,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, stock_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_user ON portfolio(user_id);

-- ── Wallet Transactions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAWAL','DEBIT','CREDIT')),
  amount      NUMERIC(18,2) NOT NULL,
  description TEXT        NOT NULL,
  balance_after NUMERIC(18,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wtxn_user ON wallet_transactions(user_id, created_at DESC);

-- ── System Logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_logs (
  id          BIGSERIAL   PRIMARY KEY,
  level       TEXT        NOT NULL CHECK (level IN ('INFO','WARN','ERROR','DEBUG')),
  module      TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  user_id     UUID        REFERENCES users(id),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON system_logs(created_at DESC);

-- ── DB Transactions Log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS db_transactions (
  id          BIGSERIAL   PRIMARY KEY,
  tables_used TEXT[]      NOT NULL,
  operations  TEXT        NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('COMMITTED','ROLLED_BACK')),
  duration_ms INT,
  initiated_by UUID       REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Locks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locks (
  id          BIGSERIAL   PRIMARY KEY,
  lock_type   TEXT        NOT NULL CHECK (lock_type IN ('ROW','TABLE')),
  table_name  TEXT        NOT NULL,
  resource    TEXT        NOT NULL,
  mode        TEXT        NOT NULL CHECK (mode IN ('SHARE','EXCLUSIVE')),
  held_ms     INT,
  status      TEXT        NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════

-- Demo user (password: password)
INSERT INTO users (id, email, password, name, role) VALUES
  ('00000000-0000-0000-0000-000000000001',
   'demo@tradeflow.in',
   '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
   'Demo User', 'USER'),
  ('00000000-0000-0000-0000-000000000002',
   'admin@tradeflow.in',
   '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
   'Admin User', 'ADMIN')
ON CONFLICT (email) DO NOTHING;

-- Wallet
INSERT INTO wallet (user_id, balance) VALUES
  ('00000000-0000-0000-0000-000000000001', 56150.70),
  ('00000000-0000-0000-0000-000000000002', 100000.00)
ON CONFLICT (user_id) DO NOTHING;

-- Stocks
INSERT INTO stocks (symbol, name, sector, price, prev_price, market_cap, volume) VALUES
  ('AAPL',  'Apple Inc.',         'Technology',    189.45, 185.20, '2.94T', '62.4M'),
  ('TSLA',  'Tesla Inc.',         'Automotive',    245.80, 238.60, '780B',  '98.2M'),
  ('NVDA',  'NVIDIA Corp.',       'Semiconductors',875.30, 842.10, '2.16T', '44.1M'),
  ('MSFT',  'Microsoft Corp.',    'Technology',    412.60, 408.90, '3.07T', '21.3M'),
  ('GOOGL', 'Alphabet Inc.',      'Technology',    165.40, 163.10, '2.07T', '25.6M'),
  ('AMZN',  'Amazon.com Inc.',    'E-Commerce',    182.90, 179.40, '1.92T', '35.8M'),
  ('META',  'Meta Platforms',     'Social Media',  528.70, 515.20, '1.35T', '18.7M'),
  ('BRK',   'Berkshire Hathaway', 'Financials',    387.20, 385.60, '843B',  '5.2M'),
  ('JPM',   'JPMorgan Chase',     'Banking',       198.45, 196.30, '572B',  '9.1M'),
  ('V',     'Visa Inc.',          'Payments',      278.30, 275.80, '567B',  '7.4M')
ON CONFLICT (symbol) DO UPDATE SET
  price      = EXCLUDED.price,
  prev_price = EXCLUDED.prev_price,
  updated_at = NOW();

-- Seed portfolio for demo user
INSERT INTO portfolio (user_id, stock_id, symbol, qty, avg_price)
SELECT '00000000-0000-0000-0000-000000000001', s.id, s.symbol, p.qty, p.avg
FROM (VALUES
  ('AAPL', 15, 172.30),
  ('TSLA',  8, 220.10),
  ('NVDA',  4, 680.50),
  ('MSFT', 10, 390.20),
  ('META',  6, 480.00)
) AS p(sym, qty, avg)
JOIN stocks s ON s.symbol = p.sym
ON CONFLICT (user_id, stock_id) DO UPDATE SET
  qty       = EXCLUDED.qty,
  avg_price = EXCLUDED.avg_price,
  updated_at = NOW();
