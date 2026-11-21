import { Injectable } from '@angular/core';

export type ImageVariant = { width: 400 | 800 | 1200; blob: Blob; bytes: number };

export type CompressedImageResult = {
  variants: ImageVariant[];
  originalBytes: number;
  compressedBytes: number;
  savingsPercent: number;
};

export type ImagePipelineStage =
  | 'decoding'
  | 'compressing'
  | 'presigning'
  | 'uploading'
  | 'finalizing'
  | 'done';

export interface ImagePipelineProgress {
  stage: ImagePipelineStage;
  percent: number;
  width?: 400 | 800 | 1200;
}

const TARGETS = [400, 800, 1200] as const;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const TARGET_MAX_VARIANT_BYTES = 500 * 1024;

@Injectable({ providedIn: 'root' })
export class ProductImagePipeline {
  async compressImage(
    file: File,
    onProgress?: (progress: ImagePipelineProgress) => void
  ): Promise<CompressedImageResult> {
    if (!file.type.startsWith('image/')) {
      throw new Error('Veuillez sélectionner un fichier image valide.');
    }
    if (file.size > MAX_SOURCE_BYTES) {
      throw new Error('L’image source doit faire 20 Mo ou moins.');
    }

    onProgress?.({ stage: 'decoding', percent: 8 });
    const image = await this.decode(file);
    try {
      onProgress?.({ stage: 'compressing', percent: 18 });
      const variants: ImageVariant[] = [];
      for (let i = 0; i < TARGETS.length; i++) {
        const width = TARGETS[i];
        const scale = Math.min(1, width / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Traitement d’image indisponible.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        let blob = await this.encodeWebP(canvas, 0.8);
        if (blob.size > TARGET_MAX_VARIANT_BYTES) {
          blob = await this.encodeWebP(canvas, 0.66);
        }
        const webpBlob =
          blob.type === 'image/webp' ? blob : new Blob([blob], { type: 'image/webp' });
        variants.push({ width, blob: webpBlob, bytes: webpBlob.size });

        const stepPercent = Math.round(20 + ((i + 1) / TARGETS.length) * 75);
        onProgress?.({ stage: 'compressing', percent: stepPercent, width });
      }

      const originalBytes = file.size;
      const compressedBytes = variants.reduce((sum, v) => sum + v.bytes, 0);
      const largestBytes = variants[variants.length - 1]?.bytes ?? compressedBytes;
      const savingsPercent =
        originalBytes > 0
          ? Math.max(0, Math.round(((originalBytes - largestBytes) / originalBytes) * 100))
          : 0;

      onProgress?.({ stage: 'done', percent: 100 });
      return {
        variants,
        originalBytes,
        compressedBytes,
        savingsPercent,
      };
    } finally {
      image.close();
    }
  }

  async createVariants(file: File): Promise<ImageVariant[]> {
    const result = await this.compressImage(file);
    return result.variants;
  }

  async upload(
    productId: number,
    altText: string,
    variants: ImageVariant[],
    apiUrl: string,
    token: string,
    color = '',
    colorHex = '',
    sortOrder = 0,
    onProgress?: (progress: ImagePipelineProgress) => void
  ): Promise<unknown> {
    const base = apiUrl.trim().replace(/\/$/, '');
    const totalBytes = Math.max(
      1,
      variants.reduce((sum, v) => sum + v.blob.size, 0)
    );

    // When backed by our Node/SQLite server, try direct-to-R2 presigned PUT first
    if (!base) {
      try {
        onProgress?.({ stage: 'presigning', percent: 6 });
        const presignRes = await fetch('/api/admin/images/presign', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            productId,
            widths: variants.map((v) => v.width),
          }),
        });

        if (presignRes.ok) {
          const presign = (await presignRes.json()) as {
            mode: 'r2-direct' | 'local';
            batchId?: string;
            uploads?: Array<{ width: 400 | 800 | 1200; putUrl: string }>;
          };

          if (presign.mode === 'r2-direct' && presign.batchId && presign.uploads?.length) {
            const loadedByWidth = new Map<number, number>();
            let directSucceeded = false;

            const emitCombinedUploadProgress = (width?: 400 | 800 | 1200) => {
              let uploaded = 0;
              for (const b of loadedByWidth.values()) uploaded += b;
              const ratio = Math.min(1, uploaded / totalBytes);
              onProgress?.({
                stage: 'uploading',
                percent: Math.round(10 + ratio * 80),
                width,
              });
            };

            try {
              onProgress?.({ stage: 'uploading', percent: 10 });
              await Promise.all(
                presign.uploads.map(async (target) => {
                  const variant = variants.find((v) => v.width === target.width);
                  if (!variant) throw new Error(`Missing variant ${target.width}px.`);
                  await this.xhrPutBlob(target.putUrl, variant.blob, (loaded) => {
                    loadedByWidth.set(target.width, loaded);
                    emitCombinedUploadProgress(target.width);
                  });
                  loadedByWidth.set(target.width, variant.blob.size);
                  emitCombinedUploadProgress(target.width);
                })
              );
              directSucceeded = true;
            } catch {
              // If R2 bucket CORS blocks browser PUT, fall back cleanly to server-side R2 S3 upload
              directSucceeded = false;
            }

            if (directSucceeded) {
              onProgress?.({ stage: 'finalizing', percent: 94 });
              const completeRes = await fetch('/api/admin/images/complete', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  productId,
                  batchId: presign.batchId,
                  altText,
                  color: color.trim(),
                  colorHex: colorHex.trim(),
                  sortOrder,
                  variants: variants.map((v) => ({ width: v.width, byteSize: v.bytes })),
                }),
              });
              if (!completeRes.ok) {
                const errData = await completeRes.json().catch(() => ({}));
                throw new Error(errData?.error || `R2 finalize failed (${completeRes.status}).`);
              }
              onProgress?.({ stage: 'done', percent: 100 });
              return completeRes.json();
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('R2 finalize failed')) {
          throw err;
        }
        // Fall through to multipart upload (server pushes to R2 bucket or local storage)
      }
    }

    const form = new FormData();
    form.append('productId', String(productId));
    form.append('altText', altText);
    form.append('sortOrder', String(sortOrder));
    if (color.trim()) form.append('color', color.trim());
    if (colorHex.trim()) form.append('colorHex', colorHex.trim());
    for (const variant of variants) {
      form.append(String(variant.width), variant.blob, `${variant.width}.webp`);
    }

    onProgress?.({ stage: 'uploading', percent: 12 });
    const result = await this.xhrPostForm(`${base}/api/admin/images`, token, form, (loaded, total) => {
      const denom = total > 0 ? total : totalBytes;
      const ratio = Math.min(1, loaded / denom);
      onProgress?.({
        stage: ratio >= 0.99 ? 'finalizing' : 'uploading',
        percent: Math.round(12 + ratio * 82),
      });
    });
    onProgress?.({ stage: 'done', percent: 100 });
    return result;
  }

  private xhrPutBlob(
    url: string,
    blob: Blob,
    onLoaded: (loadedBytes: number) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', 'image/webp');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          onLoaded(ev.loaded);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onLoaded(blob.size);
          resolve();
        } else {
          reject(new Error(`Direct R2 PUT failed (${xhr.status}).`));
        }
      };
      xhr.onerror = () => reject(new Error('Network/CORS error during direct R2 upload.'));
      xhr.onabort = () => reject(new Error('Upload aborted.'));
      xhr.send(blob);
    });
  }

  private xhrPostForm(
    url: string,
    token: string,
    form: FormData,
    onBytes: (loaded: number, total: number) => void
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          onBytes(ev.loaded, ev.total);
        }
      };
      xhr.onload = () => {
        const text = xhr.responseText || '';
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed?.error || text || `Upload failed (${xhr.status}).`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed due to network error.'));
      xhr.onabort = () => reject(new Error('Upload aborted.'));
      xhr.send(form);
    });
  }

  private encodeWebP(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Échec de conversion WebP.'))),
        'image/webp',
        quality
      )
    );
  }

  private decode(file: File): Promise<ImageBitmap> {
    return createImageBitmap(file);
  }
}
