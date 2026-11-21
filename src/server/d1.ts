export interface D1Config {
  configured: boolean;
  accountId: string;
  databaseId: string;
  databaseName: string;
  apiToken: string;
}

export interface D1SqlStatement {
  sql: string;
  params?: Array<string | number | null>;
}

export interface D1ExecResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    duration?: number;
    changes: number;
    last_row_id: number;
    changed_db?: boolean;
    rows_read?: number;
    rows_written?: number;
  };
}

interface D1ApiEnvelope<T = Record<string, unknown>> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result?: Array<D1ExecResult<T>>;
}

const DEFAULT_CF_ACCOUNT_ID = '44d2687132765f2b95d4916a4687c0c0';
const DEFAULT_D1_DATABASE_ID = '3f54f739-90d2-4f98-9a15-d4cb32c288b4';
const DEFAULT_D1_DATABASE_NAME = 'mokiko';

export function getD1Config(): D1Config {
  const accountId =
    process.env['CF_ACCOUNT_ID']?.trim() ||
    process.env['CF_D1_ACCOUNT_ID']?.trim() ||
    DEFAULT_CF_ACCOUNT_ID;
  const databaseId =
    process.env['CF_D1_DATABASE_ID']?.trim() || DEFAULT_D1_DATABASE_ID;
  const databaseName =
    process.env['CF_D1_DATABASE_NAME']?.trim() || DEFAULT_D1_DATABASE_NAME;
  const apiToken = process.env['CF_D1_API_TOKEN']?.trim() || '';

  return {
    configured: Boolean(accountId && databaseId && apiToken),
    accountId,
    databaseId,
    databaseName,
    apiToken,
  };
}

function endpointUrl(cfg: D1Config): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    cfg.accountId
  )}/d1/database/${encodeURIComponent(cfg.databaseId)}/query`;
}

export async function d1Query<T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = [],
  cfg: D1Config = getD1Config()
): Promise<D1ExecResult<T>> {
  if (!cfg.configured) {
    throw new Error(
      'Cloudflare D1 API credentials missing. Set CF_D1_API_TOKEN in environment variables.'
    );
  }

  const res = await fetch(endpointUrl(cfg), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.length ? { sql, params } : { sql }),
  });

  const data = (await res.json().catch(() => null)) as D1ApiEnvelope<T> | null;
  if (!res.ok || !data?.success || !Array.isArray(data.result) || !data.result[0]) {
    const errMsg =
      data?.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
      `Cloudflare D1 query failed with HTTP ${res.status}.`;
    throw new Error(errMsg);
  }

  const first = data.result[0];
  return {
    results: Array.isArray(first.results) ? first.results : [],
    success: Boolean(first.success),
    meta: {
      duration: Number(first.meta?.duration ?? 0),
      changes: Number(first.meta?.changes ?? 0),
      last_row_id: Number(first.meta?.last_row_id ?? 0),
      changed_db: Boolean(first.meta?.changed_db),
      rows_read: Number(first.meta?.rows_read ?? 0),
      rows_written: Number(first.meta?.rows_written ?? 0),
    },
  };
}

export async function d1Batch<T = Record<string, unknown>>(
  statements: D1SqlStatement[],
  cfg: D1Config = getD1Config()
): Promise<Array<D1ExecResult<T>>> {
  if (!statements.length) return [];
  if (!cfg.configured) {
    throw new Error(
      'Cloudflare D1 API credentials missing. Set CF_D1_API_TOKEN in environment variables.'
    );
  }

  const payload = statements.map((stmt) =>
    stmt.params?.length ? { sql: stmt.sql, params: stmt.params } : { sql: stmt.sql }
  );

  const res = await fetch(endpointUrl(cfg), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ batch: payload }),
  });

  const data = (await res.json().catch(() => null)) as D1ApiEnvelope<T> | null;
  if (!res.ok || !data?.success || !Array.isArray(data.result)) {
    const errMsg =
      data?.errors?.map((e) => e.message).filter(Boolean).join('; ') ||
      `Cloudflare D1 batch failed with HTTP ${res.status}.`;
    throw new Error(errMsg);
  }

  return data.result.map((entry) => ({
    results: Array.isArray(entry.results) ? entry.results : [],
    success: Boolean(entry.success),
    meta: {
      duration: Number(entry.meta?.duration ?? 0),
      changes: Number(entry.meta?.changes ?? 0),
      last_row_id: Number(entry.meta?.last_row_id ?? 0),
      changed_db: Boolean(entry.meta?.changed_db),
      rows_read: Number(entry.meta?.rows_read ?? 0),
      rows_written: Number(entry.meta?.rows_written ?? 0),
    },
  }));
}
