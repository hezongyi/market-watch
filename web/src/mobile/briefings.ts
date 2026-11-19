export type BriefingPlan = {
  enabled: boolean;
  group_ids: string[];
  revision: number;
  next_run_at: number | null;
  groups: { id: string; title: string }[];
  phone_available: boolean;
};
export type BriefingItem = {
  ticker: string;
  symbol?: string;
  name?: string;
  source?: string;
  basis?: string;
  category?: string;
  status: string;
  reason?: string;
  freshness?: string;
  change_pct?: string | null;
  change?: string;
  close?: string;
  previous_close?: string;
  trading_date?: string;
  previous_trading_date?: string;
  data_end?: number;
  price_description?: string;
};
export type BriefingReport = {
  id: string;
  mode: string;
  status: string;
  scheduled_for: number | null;
  cutoff_at: number;
  created_at: number;
  started_at?: number;
  finished_at?: number;
  snapshot: { groups: { id: string; title: string }[] };
  body: {
    sections?: {
      id: string;
      title: string;
      kind: string;
      items: BriefingItem[];
      error?: string;
    }[];
    issues?: string[];
    coverage?: { ok: number; total: number };
  };
  error?: string;
  delivery?: {
    status: string;
    outbox_status: string;
    attempts: number;
    reason?: string;
  };
};
