export type Severity = "info" | "warning" | "critical";
export type EventKind = "alert" | "failure" | "operation" | "success";

export type Incident = {
  id: string;
  dedupe_key: string;
  status: "open" | "resolved" | "unknown";
  severity: Severity;
  count: number;
  first_at: number;
  last_at: number;
  resolved_at: number | null;
  attention_version: number;
};

export type Observation = {
  id: string;
  event_id: string;
  kind: string;
  result: string;
  profile_id: string;
  client_at: number | null;
  server_at: number;
  client_at_iso: string | null;
  server_at_iso: string;
  meta: Record<string, unknown>;
};

export type CenterEvent = {
  schema_version: number;
  id: string;
  epoch: string | null;
  source: { kind: string; id: string; version: string };
  kind: EventKind;
  severity: Severity;
  title: string;
  summary: string;
  context: Record<string, any>;
  links: Record<string, any>;
  actions: { view?: boolean; handled?: boolean; phone_stop?: boolean };
  evidence: Record<string, any>;
  dedupe_key: string;
  incident_id: string | null;
  notification_id: string | null;
  notify_web: boolean;
  occurred_at: number;
  recorded_at: number;
  first_seq: number;
  version: number;
  deleted_at: number | null;
  read: boolean;
  incident: Incident | null;
};

export type Change = {
  epoch: string;
  seq: number;
  type: "created" | "updated" | "incident" | "observation" | "deleted";
  at: number;
  event?: CenterEvent;
  incident?: Incident;
  observation?: Observation;
};

export type Page = {
  epoch: string;
  high_watermark: number;
  items: CenterEvent[];
  next_before: string | null;
  unread: number;
};

export type Detail = {
  event: CenterEvent;
  incident: Incident | null;
  observations: Observation[];
};

export type Filters = {
  kind: string;
  severity: string;
  status: string;
  q: string;
};
