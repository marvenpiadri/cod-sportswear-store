import { Injectable } from '@angular/core';

export type ImageVariant = { width: 400 | 800 | 1200; blob: Blob; bytes: number };
const TARGETS = [400, 800, 1200] as const;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class ProductImagePipeline {
  async createVariants(file: File): Promise<ImageVariant[]> {
    if (!file.type.startsWith('image/')) throw new Error('Select an image file.');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('Image must be 20 MB or smaller.');
    const image = await this.decode(file);
    try {
      return await Promise.all(TARGETS.map(async width => {
        const scale = Math.min(1, width / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to process this image.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(result => result ? resolve(result) : reject(new Error('WebP conversion failed.')), 'image/webp', 0.82));
        return { width, blob, bytes: blob.size } as ImageVariant;
      }));
    } finally { image.close(); }
  }

  async upload(productId: number, altText: string, variants: ImageVariant[], apiUrl: string, token: string): Promise<unknown> {
    const form = new FormData();
    form.append('productId', String(productId)); form.append('altText', altText);
    for (const variant of variants) form.append(String(variant.width), variant.blob, `${variant.width}.webp`);
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/admin/images`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    if (!response.ok) throw new Error((await response.text()) || `Upload failed (${response.status}).`);
    return response.json();
  }

  private decode(file: File): Promise<ImageBitmap> {
    return createImageBitmap(file);
  }
}
