// server.js — TradeFlow Express Server
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const authRouter      = require('./routes/auth');
const stocksRouter    = require('./routes/stocks');
const ordersRouter    = require('./routes/orders');
const portfolioRouter = require('./routes/portfolio');
const walletRouter    = require('./routes/wallet');
const adminRouter     = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// Request logger (dev)
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/stocks',    stocksRouter);
app.use('/api/orders',    ordersRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/wallet',    walletRouter);
app.use('/api/admin',     adminRouter);

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[SERVER] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`✅ TradeFlow API running on http://localhost:${PORT}`);
});
