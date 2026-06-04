-- Modul 4: Personlig finans (bank-CSV + Storebox).
-- Alle tabeller: RLS slået til UDEN policies (deny-all). Kun service_role (via
-- getSupabase()) kan læse/skrive - samme mønster som resten af systemet.
-- Datakilder: bank-CSV = kanonisk transaktion + saldo. Storebox = kvitteringer
-- med varelinjer der HÆGTES PÅ den matchende bank-transaktion (ikke separate).

-- 1) Bank-transaktioner (kanonisk record, én pr. CSV-linje).
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  booked_date date not null,
  text_raw text not null default '',          -- kort tekst (CSV kolonne 5)
  detail text not null default '',            -- rig tekst (Forretning/By/Kortnr, kolonne 9)
  counterparty text not null default '',      -- modpart (kolonne 8, fx MobilePay-lokation)
  amount numeric not null,                    -- negativ = udgift, positiv = indkomst
  balance numeric,                            -- kontosaldo efter posteringen (driver nettoformue)
  category text,                              -- en af CATEGORIES, null indtil klassificeret
  sin_tag text,                               -- null eller et SIN_TAG (takeaway, alkohol ...)
  category_source text not null default 'ai'
    check (category_source in ('ai', 'manual', 'rule', 'storebox')),
  status text not null default 'classified'
    check (status in ('classified', 'needs_review')),
  storebox_receipt_id text,                   -- Storebox receiptId når en kvittering er matchet på
  note text,
  import_id uuid,
  import_hash text not null unique,           -- idempotens: hash(dato|tekst|beløb|saldo|ref)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_transactions_date on transactions (booked_date desc);
create index if not exists idx_transactions_status on transactions (status);
create index if not exists idx_transactions_sin on transactions (sin_tag) where sin_tag is not null;
create index if not exists idx_transactions_category on transactions (category);
alter table transactions enable row level security;

-- 2) Varelinjer (fra Storebox, hægtet på en transaktion). Muliggør kategorisering
--    pr. vare: "133 i Netto" = 80 grønt + 53 øl.
create table if not exists transaction_lines (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions (id) on delete cascade,
  receipt_id text,                            -- Storebox receiptId (sporbarhed)
  line_number int not null default 0,
  text text not null default '',
  amount numeric not null,                    -- linjens totalpris (kan være negativ, fx rabat)
  category text,
  sin_tag text,
  created_at timestamptz not null default now()
);
create index if not exists idx_tx_lines_tx on transaction_lines (transaction_id);
alter table transaction_lines enable row level security;

-- 3) Storebox-kvitteringer (rå, idempotent via receipt_id). Hele historikken sendes
--    hver gang; vi selekterer selv nye fra. matched_transaction_id sættes ved reconcile.
create table if not exists storebox_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_id text not null unique,            -- Storebox' egen stabile id
  receipt_date date not null,
  purchase_ts timestamptz,
  merchant text not null default '',
  merchant_city text,
  total_amount numeric not null,
  line_items jsonb not null default '[]',     -- normaliserede varelinjer
  matched_transaction_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_receipts_date on storebox_receipts (receipt_date desc);
create index if not exists idx_receipts_unmatched on storebox_receipts (matched_transaction_id)
  where matched_transaction_id is null;
alter table storebox_receipts enable row level security;

-- 4) Nettoformue-snapshots (dagligt). checking = seneste CSV-saldo den dag.
--    Øvrige aktiver/gæld kopieres ind fra manual_balances ved snapshot.
create table if not exists net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null unique,
  checking numeric,
  other_assets jsonb not null default '[]',
  liabilities jsonb not null default '[]',
  net_worth numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_networth_date on net_worth_snapshots (snapshot_date desc);
alter table net_worth_snapshots enable row level security;

-- 5) Manuelle balancer (opsparing, investering, SU-gæld) - redigeres i en lille form
--    på /finans. Indgår i nettoformue oven på checking-saldoen.
create table if not exists manual_balances (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  amount numeric not null default 0,
  kind text not null default 'asset' check (kind in ('asset', 'liability')),
  sort int not null default 0,
  updated_at timestamptz not null default now()
);
alter table manual_balances enable row level security;

-- 6) Import-log (revisionsspor for hver upload).
create table if not exists finance_imports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bank', 'storebox')),
  filename text,
  row_count int not null default 0,
  created_at timestamptz not null default now()
);
alter table finance_imports enable row level security;

notify pgrst, 'reload schema';
