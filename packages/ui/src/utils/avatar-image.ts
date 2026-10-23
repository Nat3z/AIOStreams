/** The side of an uploaded picture, which shows no bigger than this. */
const SIDE = 512;

/**
 * A picked photo as a square WebP the server takes: cropped to its centre and
 * scaled down, so a phone's photo uploads as a few dozen KB.
 */
export async function avatarImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const crop = Math.min(bitmap.width, bitmap.height);
  const side = Math.min(SIDE, crop);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      (bitmap.width - crop) / 2,
      (bitmap.height - crop) / 2,
      crop,
      crop,
      0,
      0,
      side,
      side
    );
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.85)
  );
  // Safari draws no WebP, and falls back to PNG; JPEG keeps it small.
  const out =
    blob?.type === 'image/webp'
      ? blob
      : await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85)
        );
  if (!out) throw new Error('Could not read that image');
  return new File([out], 'avatar', { type: out.type });
}
