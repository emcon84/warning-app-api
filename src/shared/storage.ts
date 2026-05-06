import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

const BUCKET = () => process.env.R2_BUCKET_NAME || "warning-app-images";
const PUBLIC_URL = () => process.env.R2_PUBLIC_URL!;

/**
 * Sube un buffer a Cloudflare R2 y devuelve la URL pública.
 * El filename debe incluir la extensión: `comercio_{uuid}.jpg`
 */
export async function uploadToR2(
  buffer: ArrayBuffer,
  filename: string,
  contentType: string
): Promise<string> {
  await getClient().send(
    new PutObjectCommand({
      Bucket:      BUCKET(),
      Key:         filename,
      Body:        Buffer.from(buffer),
      ContentType: contentType,
    })
  );
  return `${PUBLIC_URL()}/${filename}`;
}

/**
 * Extrae la extensión de un File y genera un nombre único para R2.
 * prefix: "comercio" | "producto" | "post" | "professional"
 */
export function generateFilename(file: File, prefix: string): string {
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  return `${prefix}_${crypto.randomUUID()}.${ext}`;
}

/**
 * Sube un File a R2 si tiene contenido. Devuelve la URL o null.
 */
export async function uploadFileToR2(
  file: File | null | undefined,
  prefix: string
): Promise<string | null> {
  if (!file || file.size === 0) return null;
  const filename = generateFilename(file, prefix);
  return uploadToR2(await file.arrayBuffer(), filename, file.type || "image/jpeg");
}
