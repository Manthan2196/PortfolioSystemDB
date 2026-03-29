// routes/orders.js — /api/orders
// All trade operations use explicit PostgreSQL transactions (BEGIN/COMMIT/ROLLBACK)
// to guarantee atomicity across: orders, trades, portfolio, wallet, wallet_transactions,
// system_logs, and db_transactions tables.

const router = require('express').Router();
const { client: getClient, query } = require('../db');
const { requireAuth } = require('../middleware/auth');

/* ─────────────────────────────────────────────────────────────
   Helper: insert a system log row (inside an open pg client)
───────────────────────────────────────────────────────────── */
async function insertLog(pgClient, level, module_, message, userId, metadata = {}) {
  await pgClient.query(
    `INSERT INTO system_logs (level, module, message, user_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [level, module_, message, userId, JSON.stringify(metadata)]
  );
}

/* ─────────────────────────────────────────────────────────────
   Helper: record a db_transactions entry
───────────────────────────────────────────────────────────── */
async function recordDbTxn(pgClient, tables, ops, status, durationMs, userId) {
  await pgClient.query(
    `INSERT INTO db_transactions (tables_used, operations, status, duration_ms, initiated_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [tables, ops, status, durationMs, userId]
  );
}

/* ═══════════════════════════════════════════════════════════
   POST /api/orders  — place a BUY or SELL order
   Body: { stock_id, order_type, price_type, qty, price }
═══════════════════════════════════════════════════════════ */
router.post('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { stock_id, order_type, price_type = 'MARKET', qty, price } = req.body;

  // ── Input validation ──────────────────────────────────────
  if (!stock_id || !order_type || !qty || !price) {
    return res.status(400).json({ error: 'stock_id, order_type, qty, and price are required.' });
  }
  if (!['BUY', 'SELL'].includes(order_type)) {
    return res.status(400).json({ error: 'order_type must be BUY or SELL.' });
  }
  const qtyInt   = parseInt(qty);
  const priceNum = parseFloat(price);
  if (isNaN(qtyInt) || qtyInt <= 0) {
    return res.status(400).json({ error: 'qty must be a positive integer.' });
  }
  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: 'price must be a positive number.' });
  }

  const total    = parseFloat((qtyInt * priceNum).toFixed(2));
  const startMs  = Date.now();
  const pgClient = await getClient();

  try {
    // ── BEGIN transaction ─────────────────────────────────
    await pgClient.query('BEGIN');

    // ── 1. Fetch stock (lock row for update) ──────────────
    const stockRes = await pgClient.query(
      'SELECT id, symbol, name, price FROM stocks WHERE id = $1 FOR UPDATE',
      [stock_id]
    );
    if (stockRes.rows.length === 0) {
      await pgClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Stock not found.' });
    }
    const stock      = stockRes.rows[0];
    const execPrice  = priceNum; // use submitted price (market or limit)

    // ── 2. Fetch wallet (lock for update) ─────────────────
    const walletRes = await pgClient.query(
      'SELECT id, balance FROM wallet WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (walletRes.rows.length === 0) {
      await pgClient.query('ROLLBACK');
      return res.status(400).json({ error: 'Wallet not found for user.' });
    }
    const wallet = walletRes.rows[0];

    // ── 3. BUY-specific validation ────────────────────────
    if (order_type === 'BUY') {
      if (parseFloat(wallet.balance) < total) {
        await pgClient.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient balance. Need ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}, available ₹${parseFloat(wallet.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`,
        });
      }
    }

    // ── 4. SELL-specific validation ───────────────────────
    let holdingRow = null;
    if (order_type === 'SELL') {
      const holdingRes = await pgClient.query(
        'SELECT id, qty, avg_price FROM portfolio WHERE user_id = $1 AND stock_id = $2 FOR UPDATE',
        [userId, stock_id]
      );
      if (holdingRes.rows.length === 0 || parseInt(holdingRes.rows[0].qty) < qtyInt) {
        const held = holdingRes.rows[0]?.qty || 0;
        await pgClient.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient shares. You hold ${held} share(s) of ${stock.symbol}, tried to sell ${qtyInt}.`,
        });
      }
      holdingRow = holdingRes.rows[0];
    }

    // ── 5. Insert order ────────────────────────────────────
    const orderRes = await pgClient.query(
      `INSERT INTO orders
         (user_id, stock_id, symbol, order_type, price_type, qty, price, total, status, executed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EXECUTED', NOW())
       RETURNING *`,
      [userId, stock_id, stock.symbol, order_type, price_type, qtyInt, execPrice, total]
    );
    const order = orderRes.rows[0];

    // ── 6. Compute P&L for SELL orders ────────────────────
    let pnl = 0;
    if (order_type === 'SELL' && holdingRow) {
      const avgBuy = parseFloat(holdingRow.avg_price);
      pnl = parseFloat(((execPrice - avgBuy) * qtyInt).toFixed(2));
    }

    // ── 7. Insert trade record ─────────────────────────────
    await pgClient.query(
      `INSERT INTO trades
         (order_id, user_id, stock_id, symbol, trade_type, qty, price, total, pnl)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [order.id, userId, stock_id, stock.symbol, order_type, qtyInt, execPrice, total, pnl]
    );

    // ── 8. Update wallet balance ───────────────────────────
    let newBalance;
    if (order_type === 'BUY') {
      newBalance = parseFloat((parseFloat(wallet.balance) - total).toFixed(2));
    } else {
      newBalance = parseFloat((parseFloat(wallet.balance) + total).toFixed(2));
    }

    await pgClient.query(
      'UPDATE wallet SET balance = $1, updated_at = NOW() WHERE user_id = $2',
      [newBalance, userId]
    );

    // ── 9. Insert wallet transaction record ────────────────
    const wtDesc = order_type === 'BUY'
      ? `BUY ${qtyInt} × ${stock.symbol} @ ₹${execPrice}`
      : `SELL ${qtyInt} × ${stock.symbol} @ ₹${execPrice}`;

    await pgClient.query(
      `INSERT INTO wallet_transactions
         (user_id, type, amount, description, balance_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        order_type === 'BUY' ? 'DEBIT' : 'CREDIT',
        order_type === 'BUY' ? -total  : total,
        wtDesc,
        newBalance,
      ]
    );

    // ── 10. Update portfolio ───────────────────────────────
    if (order_type === 'BUY') {
      // Upsert: if holding exists update avg_price + qty, else insert
      await pgClient.query(
        `INSERT INTO portfolio (user_id, stock_id, symbol, qty, avg_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, stock_id) DO UPDATE
           SET qty       = portfolio.qty + EXCLUDED.qty,
               avg_price = (
                 (portfolio.avg_price * portfolio.qty + EXCLUDED.avg_price * EXCLUDED.qty)
                 / (portfolio.qty + EXCLUDED.qty)
               ),
               updated_at = NOW()`,
        [userId, stock_id, stock.symbol, qtyInt, execPrice]
      );
    } else {
      // Reduce qty; if qty reaches 0, remove row
      const remainingQty = parseInt(holdingRow.qty) - qtyInt;
      if (remainingQty === 0) {
        await pgClient.query(
          'DELETE FROM portfolio WHERE user_id = $1 AND stock_id = $2',
          [userId, stock_id]
        );
      } else {
        await pgClient.query(
          `UPDATE portfolio SET qty = $1, updated_at = NOW()
           WHERE user_id = $2 AND stock_id = $3`,
          [remainingQty, userId, stock_id]
        );
      }
    }

    // ── 11. System log ─────────────────────────────────────
    await insertLog(
      pgClient, 'INFO', 'OrderEngine',
      `Order ${order.id} EXECUTED — ${order_type} ${qtyInt} × ${stock.symbol} @ ₹${execPrice} | Total: ₹${total}`,
      userId,
      { order_id: order.id, pnl }
    );

    // ── 12. DB transaction record ──────────────────────────
    const durationMs = Date.now() - startMs;
    const tables = order_type === 'BUY'
      ? ['orders', 'trades', 'wallet', 'wallet_transactions', 'portfolio']
      : ['orders', 'trades', 'wallet', 'wallet_transactions', 'portfolio'];
    const ops = order_type === 'BUY'
      ? 'INSERT orders, INSERT trades, UPDATE wallet, INSERT wallet_txn, UPSERT portfolio'
      : 'INSERT orders, INSERT trades, UPDATE wallet, INSERT wallet_txn, UPDATE/DELETE portfolio';

    await recordDbTxn(pgClient, tables, ops, 'COMMITTED', durationMs, userId);

    // ── COMMIT ─────────────────────────────────────────────
    await pgClient.query('COMMIT');

    res.status(201).json({
      message: `${order_type} order executed successfully.`,
      order,
      newBalance,
      pnl,
    });

  } catch (err) {
    await pgClient.query('ROLLBACK');

    // Log failed transaction
    try {
      const durationMs = Date.now() - startMs;
      await query(
        `INSERT INTO system_logs (level, module, message, user_id) VALUES ('ERROR','OrderEngine',$1,$2)`,
        [`Order FAILED — ${order_type} ${qty} × (stock_id=${stock_id}): ${err.message}`, userId]
      );
      await query(
        `INSERT INTO db_transactions (tables_used, operations, status, duration_ms, initiated_by)
         VALUES ($1,$2,'ROLLED_BACK',$3,$4)`,
        [['orders'], `${order_type} attempt`, durationMs, userId]
      );
    } catch (_) { /* best-effort */ }

    console.error('[ORDERS] Transaction error:', err.message);
    res.status(500).json({ error: 'Order execution failed. Please try again.' });
  } finally {
    pgClient.release();
  }
});

/* ── GET /api/orders — user's order history ─────────────── */
router.get('/', requireAuth, async (req, res) => {
  const { status, limit = 50 } = req.query;
  try {
    let sql = `
      SELECT o.id, o.symbol, o.order_type, o.price_type,
             o.qty, o.price, o.total, o.status,
             o.created_at, o.executed_at,
             s.name AS stock_name
      FROM   orders o
      JOIN   stocks s ON s.id = o.stock_id
      WHERE  o.user_id = $1
    `;
    const params = [req.user.id];
    if (status) {
      sql += ` AND o.status = $2`;
      params.push(status.toUpperCase());
    }
    sql += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const { rows } = await query(sql, params);
    res.json({ orders: rows });
  } catch (err) {
    console.error('[ORDERS] Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders.' });
  }
});

/* ── GET /api/orders/trades — executed trades ───────────── */
router.get('/trades', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.order_id, t.symbol, t.trade_type,
              t.qty, t.price, t.total, t.pnl, t.executed_at,
              s.name AS stock_name
       FROM   trades t
       JOIN   stocks s ON s.id = t.stock_id
       WHERE  t.user_id = $1
       ORDER  BY t.executed_at DESC
       LIMIT  100`,
      [req.user.id]
    );
    res.json({ trades: rows });
  } catch (err) {
    console.error('[TRADES] Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch trades.' });
  }
});

/* ── DELETE /api/orders/:id — cancel an OPEN order ──────── */
router.delete('/:id', requireAuth, async (req, res) => {
  const pgClient = await getClient();
  try {
    await pgClient.query('BEGIN');
    const { rows } = await pgClient.query(
      `UPDATE orders SET status = 'CANCELLED'
       WHERE id = $1 AND user_id = $2 AND status = 'OPEN'
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) {
      await pgClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or cannot be cancelled.' });
    }
    await insertLog(pgClient, 'INFO', 'OrderEngine', `Order ${req.params.id} cancelled by user`, req.user.id);
    await pgClient.query('COMMIT');
    res.json({ message: 'Order cancelled.', order: rows[0] });
  } catch (err) {
    await pgClient.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to cancel order.' });
  } finally {
    pgClient.release();
  }
});

module.exports = router;
