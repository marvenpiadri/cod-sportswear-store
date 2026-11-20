# Product image upload pipeline

Images are resized and encoded in the browser as WebP (quality 0.82) at 400px, 800px and 1200px, preserving aspect ratio. Variants are uploaded to the Worker, which validates type and size, stores bytes in R2, and records variant metadata in D1. The Worker does not resize images.

## Temporary test setup

The Wrangler config currently targets the temporary D1 and R2 resources. The public R2 development URL is configured as PUBLIC_MEDIA_BASE.

Before using the upload endpoint, apply the migration and set the admin PIN secret:

```bash
cd worker
npx wrangler d1 migrations apply mokiko --remote
npx wrangler secret put ADMIN_PIN
npx wrangler deploy
```

Do not commit the ADMIN_PIN. It must be a unique five-digit PIN; the Worker applies per-IP attempt throttling. The upload endpoint is POST /api/admin/images and requires Authorization: Bearer <token>. Multipart fields: productId, altText and one or more WebP files named 400, 800, 1200. Each file must be <= 5 MB. A product must exist before its images can be uploaded.

## Later client migration

Replace the database ID, R2 binding, bucket name and public media URL in Wrangler config with client-account values, then apply migrations and set the secret in the client's account. Keep the API and image pipeline unchanged.
