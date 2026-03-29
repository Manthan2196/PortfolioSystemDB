# TradeFlow — Stock Trading Platform

Production-grade stock trading system with atomic SQL transactions, role-based access, real API integration, and dynamic UI.

---

## Project Structure

```
tradeflow/
├── backend/
│   ├── server.js           ← Express entry point
│   ├── db.js               ← pg Pool connection
│   ├── schema.sql          ← Full DB schema + seed data
│   ├── .env.example        ← Environment variable template
│   ├── package.json
│   ├── middleware/
│   │   └── auth.js         ← JWT verify + role guard
│   └── routes/
│       ├── auth.js         ← POST /api/auth/login
│       ├── stocks.js       ← GET /api/stocks, /api/stocks/:sym/history
│       ├── orders.js       ← POST/GET /api/orders (BUY + SELL)
│       ├── portfolio.js    ← GET /api/portfolio
│       ├── wallet.js       ← GET/POST /api/wallet/*
│       └── admin.js        ← GET /api/admin/* (ADMIN only)
└── frontend/
    └── index.html          ← Single-file React app (CDN, no build)
```

---

## Quick Start

### 1. PostgreSQL Setup

```bash
createdb tradeflow
psql -d tradeflow -f backend/schema.sql
```

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your DB credentials

npm install
npm run dev          # nodemon for hot reload
# or
npm start            # production
```

Backend runs on **http://localhost:4000**

### 3. Frontend

Open `frontend/index.html` directly in your browser.
No build step required — uses CDN React + Babel.

---

## Demo Accounts

| Role  | Email                  | Password  |
|-------|------------------------|-----------|
| USER  | demo@tradeflow.in      | password  |
| ADMIN | admin@tradeflow.in     | password  |

---

## API Endpoints

| Method | Path                          | Auth   | Role  | Description              |
|--------|-------------------------------|--------|-------|--------------------------|
| POST   | /api/auth/login               | None   | Any   | Login → JWT token        |
| GET    | /api/auth/me                  | JWT    | Any   | Current user info        |
| GET    | /api/stocks                   | JWT    | Any   | All stocks               |
| GET    | /api/stocks/:symbol/history   | JWT    | Any   | Price history (30d)      |
| POST   | /api/orders                   | JWT    | Any   | Place BUY or SELL order  |
| GET    | /api/orders                   | JWT    | Any   | User order history       |
| GET    | /api/orders/trades            | JWT    | Any   | Executed trades          |
| DELETE | /api/orders/:id               | JWT    | Any   | Cancel OPEN order        |
| GET    | /api/portfolio                | JWT    | Any   | User portfolio           |
| GET    | /api/wallet                   | JWT    | Any   | Wallet balance           |
| GET    | /api/wallet/transactions      | JWT    | Any   | Transaction history      |
| POST   | /api/wallet/deposit           | JWT    | Any   | Deposit funds            |
| POST   | /api/wallet/withdraw          | JWT    | Any   | Withdraw funds           |
| GET    | /api/admin/logs               | JWT    | ADMIN | System logs              |
| GET    | /api/admin/db-transactions    | JWT    | ADMIN | DB transaction log       |
| GET    | /api/admin/locks              | JWT    | ADMIN | Lock manager             |
| GET    | /api/admin/stats              | JWT    | ADMIN | Platform statistics      |

---

## Core Fixes Applied

### 1. SELL Flow (Fully Fixed)
- Validates user holds enough shares (`portfolio` row lock)
- Calculates P&L: `(sell_price - avg_buy_price) × qty`
- Deletes portfolio row if qty reaches 0, otherwise reduces qty
- Credits wallet and inserts wallet_transaction (CREDIT)
- All inside a single `BEGIN … COMMIT` block

### 2. Atomic Transactions
Every trade executes this sequence inside one PostgreSQL transaction:
```
BEGIN
  → SELECT … FOR UPDATE (wallet + portfolio — row-level locks)
  → Validate (balance / shares)
  → INSERT orders
  → INSERT trades
  → UPDATE wallet balance
  → INSERT wallet_transactions
  → UPSERT / UPDATE / DELETE portfolio
  → INSERT system_logs
  → INSERT db_transactions
COMMIT  (or ROLLBACK on any error)
```

### 3. No Optimistic Updates
- All state (`wallet`, `portfolio`, `orders`) is re-fetched from the DB after every action
- `refreshAll()` calls 4 endpoints in parallel after trade execution
- UI only shows confirmed server data

### 4. Role-Based Access
- Backend: `requireRole('ADMIN')` middleware on all `/api/admin/*` routes
- Frontend: Admin pages show "Access Denied" for USER role
- Sidebar hides Admin section for non-admin users
- JWT carries `{ id, email, name, role }` — no client-side role mutation possible

### 5. Dynamic UI Features
- **Skeleton loaders** on every table and stat section
- **Animated counters** on wallet balance and portfolio value
- **5-second polling** for wallet balance and stock prices
- **Session persistence** — JWT stored in localStorage, restored on reload
- **Per-page fade-up animations** on route change
- **Inline error + success banners** replace console.log failures
- **Toast notifications** on order success/failure/cancel
- **Cancel open order** from Orders page with spinner feedback
- **Preselect stock** — clicking Trade on Markets page pre-fills Order form

---

## Environment Variables

```env
PORT=4000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tradeflow
DB_USER=postgres
DB_PASSWORD=your_password
JWT_SECRET=long_random_secret_here
FRONTEND_URL=http://localhost:3000
```
