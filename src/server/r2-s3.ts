import crypto from 'node:crypto';

export interface R2Config {
  configured: boolean;
  bucket: string;
  endpointOrigin: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const DEFAULT_S3_ENDPOINT = 'https://44d2687132765f2b95d4916a4687c0c0.r2.cloudflarestorage.com';
const DEFAULT_BUCKET = 'mokiko';
const DEFAULT_PUBLIC_URL = 'https://pub-22f1ea2ceedc494a88c49453ea8b15bd.r2.dev';
const R2_REGION = 'auto';
const R2_SERVICE = 's3';

function isSafeHttpsUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getR2Config(): R2Config {
  const bucket = process.env['R2_BUCKET']?.trim() || DEFAULT_BUCKET;
  const rawEndpoint = process.env['R2_S3_ENDPOINT']?.trim() || DEFAULT_S3_ENDPOINT;
  const parsedEndpoint = isSafeHttpsUrl(rawEndpoint);
  const endpointOrigin = parsedEndpoint ? parsedEndpoint.origin : '';

  const rawPublic = (process.env['R2_PUBLIC_URL']?.trim() || DEFAULT_PUBLIC_URL).replace(/\/$/, '');
  const parsedPublic = isSafeHttpsUrl(rawPublic);
  const publicBaseUrl = parsedPublic ? rawPublic : '';

  const accessKeyId = process.env['R2_ACCESS_KEY_ID']?.trim() || '';
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY']?.trim() || '';

  return {
    configured: Boolean(accessKeyId && secretAccessKey && endpointOrigin && bucket && publicBaseUrl),
    bucket,
    endpointOrigin,
    publicBaseUrl,
    accessKeyId,
    secretAccessKey,
  };
}

export function buildPublicObjectUrl(objectKey: string, cfg = getR2Config()): string {
  const cleanKey = objectKey.replace(/^\/+/, '');
  return `${cfg.publicBaseUrl}/${cleanKey}`;
}

export function extractR2ObjectKey(storageKeyOrUrl: string, cfg = getR2Config()): string | null {
  const prefix = `${cfg.publicBaseUrl}/`;
  if (cfg.publicBaseUrl && storageKeyOrUrl.startsWith(prefix)) {
    const key = storageKeyOrUrl.slice(prefix.length).trim();
    return key || null;
  }
  return null;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function deriveSigningKey(secretAccessKey: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, R2_REGION);
  const kService = hmac(kRegion, R2_SERVICE);
  return hmac(kService, 'aws4_request');
}

function formatAmzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function buildCanonicalUri(bucket: string, objectKey: string): string {
  const cleanSegments = objectKey
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeRfc3986);
  return `/${encodeRfc3986(bucket)}/${cleanSegments.join('/')}`;
}

export function presignPutObject(
  objectKey: string,
  expiresSeconds = 300,
  cfg = getR2Config()
): { putUrl: string; objectKey: string; publicUrl: string } {
  if (!cfg.configured) {
    throw new Error('Cloudflare R2 credentials are not configured on the server.');
  }

  const endpointUrl = new URL(cfg.endpointOrigin);
  const host = endpointUrl.host;
  const canonicalUri = buildCanonicalUri(cfg.bucket, objectKey);
  const { amzDate, dateStamp } = formatAmzDates();
  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const queryParams: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  const canonicalQuery = queryParams
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp);
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');

  return {
    putUrl: `${cfg.endpointOrigin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    objectKey: objectKey.replace(/^\/+/, ''),
    publicUrl: buildPublicObjectUrl(objectKey, cfg),
  };
}

async function signedS3Request(
  method: 'PUT' | 'HEAD' | 'DELETE',
  objectKey: string,
  body?: Buffer,
  extraHeaders: Record<string, string> = {},
  cfg = getR2Config()
): Promise<Response> {
  if (!cfg.configured) {
    throw new Error('Cloudflare R2 credentials are not configured on the server.');
  }

  const endpointUrl = new URL(cfg.endpointOrigin);
  const host = endpointUrl.host;
  const canonicalUri = buildCanonicalUri(cfg.bucket, objectKey);
  const { amzDate, dateStamp } = formatAmzDates();
  const payloadHash = sha256Hex(body ?? Buffer.alloc(0));
  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp);
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`${cfg.endpointOrigin}${canonicalUri}`, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...extraHeaders,
    },
    body: body ? new Uint8Array(body) : undefined,
  });
}

export async function putObjectToR2(
  objectKey: string,
  buffer: Buffer,
  contentType = 'image/webp',
  cfg = getR2Config()
): Promise<string> {
  const res = await signedS3Request(
    'PUT',
    objectKey,
    buffer,
    {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    cfg
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`R2 upload failed (${res.status}): ${errText.slice(0, 180) || res.statusText}`);
  }
  return buildPublicObjectUrl(objectKey, cfg);
}

export async function headR2Object(objectKey: string, cfg = getR2Config()): Promise<boolean> {
  const res = await signedS3Request('HEAD', objectKey, undefined, {}, cfg);
  return res.ok;
}

export async function deleteR2Object(objectKey: string, cfg = getR2Config()): Promise<void> {
  if (!cfg.configured) return;
  try {
    await signedS3Request('DELETE', objectKey, undefined, {}, cfg);
  } catch {
    // Ignore transient delete errors
  }
}
