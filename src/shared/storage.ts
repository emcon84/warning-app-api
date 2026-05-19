import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

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

const BUCKET     = () => process.env.R2_BUCKET_NAME || "warning-app-images";
const PUBLIC_URL = () => process.env.R2_PUBLIC_URL!;

const SKIP_CONVERT = new Set(["image/svg+xml", "image/gif"]);
const MAX_WIDTH    = 1920;

async function toWebP(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

export async function uploadToR2(
  buffer: Buffer | ArrayBuffer,
  filename: string,
  contentType: string
): Promise<string> {
  const body = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
  await getClient().send(
    new PutObjectCommand({
      Bucket:      BUCKET(),
      Key:         filename,
      Body:        body,
      ContentType: contentType,
    })
  );
  return `${PUBLIC_URL()}/${filename}`;
}

export async function uploadFileToR2(
  file: File | null | undefined,
  prefix: string
): Promise<string | null> {
  if (!file || file.size === 0) return null;

  const mime = (file.type || "image/jpeg").toLowerCase();

  if (SKIP_CONVERT.has(mime)) {
    const ext      = file.name.split(".").pop()?.toLowerCase() || "bin";
    const filename = `${prefix}_${crypto.randomUUID()}.${ext}`;
    return uploadToR2(await file.arrayBuffer(), filename, mime);
  }

  const original = Buffer.from(await file.arrayBuffer());
  const webp     = await toWebP(original);
  const filename = `${prefix}_${crypto.randomUUID()}.webp`;
  return uploadToR2(webp, filename, "image/webp");
}
