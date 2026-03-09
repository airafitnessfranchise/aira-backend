// storage.js — Cloudflare R2 upload + signed URL generation
// R2 is S3-compatible; we use the AWS SDK v3.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');

let r2Client = null;

function getR2Client() {
  if (!r2Client) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      console.warn('[R2] Missing env vars — R2 storage disabled. Files will stay local.');
      return null;
    }

    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    });
  }
  return r2Client;
}

/**
 * Upload a local audio file to R2.
 * Returns the R2 object key (or null if R2 is not configured).
 */
async function uploadToR2(localFilePath, recordingId) {
  const client = getR2Client();
  if (!client) return null;

  const bucket = process.env.R2_BUCKET_NAME || 'aira-recordings';
  const ext = path.extname(localFilePath) || '.webm';
  const key = `recordings/${recordingId}${ext}`;

  const fileBuffer = fs.readFileSync(localFilePath);

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: 'audio/webm'
  }));

  console.log(`[R2] Uploaded ${key} to bucket ${bucket}`);
  return key;
}

/**
 * Generate a presigned URL valid for linkExpirySeconds (default 7 days).
 * Returns null if R2 is not configured.
 */
async function getPresignedUrl(r2Key, linkExpirySeconds = 60 * 60 * 24 * 7) {
  const client = getR2Client();
  if (!client || !r2Key) return null;

  const bucket = process.env.R2_BUCKET_NAME || 'aira-recordings';

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: r2Key }),
    { expiresIn: linkExpirySeconds }
  );

  return url;
}

module.exports = { uploadToR2, getPresignedUrl };
