# Backup and recovery

This is an operator runbook for the current temporary Cloudflare resources. Replace the database and bucket names when moving the store to its owner's account. Backups contain customer names, phone numbers and delivery addresses: encrypt them, restrict access, keep them outside the production account where practical, and never commit them to Git.

## D1 database backup

From the `worker/` directory, export the full schema and data:

```bash
mkdir -p ../backups
npx wrangler d1 export mokiko --remote --output=../backups/mokiko-$(date +%F).sql
```

Store the resulting SQL file in encrypted backup storage. Keep a separate copy of the export before any schema migration or bulk data operation. Wrangler's D1 migration apply flow also captures a backup before applying pending migrations, but that should not replace an independent export.

## D1 point-in-time recovery

Inspect the current Time Travel bookmark:

```bash
npx wrangler d1 time-travel info mokiko
```

If recovery is required, record the current bookmark and export the current database first. Then restore only after identifying the correct recovery bookmark and obtaining explicit production approval:

```bash
npx wrangler d1 time-travel restore mokiko --bookmark=REPLACE_WITH_APPROVED_BOOKMARK
```

Time Travel retention depends on the Cloudflare plan (currently up to 7 days on Free and 30 days on Paid). Confirm the actual account entitlement before relying on it.

## R2 product media backup

Use the AWS CLI with an R2 S3-compatible endpoint and an R2 access key. Keep credentials in the operator's secret manager or environment, not in this repository.

Download a full copy of the bucket:

```bash
aws s3 sync s3://mokiko ../backups/r2-mokiko \
  --endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com
```

Restore objects to the target bucket without deleting objects that are not in the backup:

```bash
aws s3 sync ../backups/r2-mokiko s3://mokiko \
  --endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com
```

Do not add the `--delete` option during a recovery unless a separately reviewed restore plan explicitly requires it. Keep at least one copy of the media outside the same R2 bucket/account.

## Restore drill before launch

- [ ] Export D1 and copy R2 media to independent backup storage.
- [ ] Restore the SQL export into a separate, non-production D1 database.
- [ ] Restore media into a separate R2 bucket.
- [ ] Verify product records, order records, variant stock and stock movement history.
- [ ] Verify every `image_variants.r2_key` referenced by D1 exists in the restored bucket.
- [ ] Point a non-production Worker at the restored resources and run checkout, product image and CRM smoke tests.
- [ ] Record the date, operator, restore duration and any missing data.

Never test a restore by overwriting the live store. Production recovery, migration application and resource changes require explicit owner approval.
