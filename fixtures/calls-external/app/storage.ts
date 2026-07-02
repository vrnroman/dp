// Keeps uploaded files on Amazon S3 (an external object store, not the platform's own storage).
// The compliance evaluator should surface this as a service to approve, from the SDK dependency
// and the AWS_S3_BUCKET secret — no literal S3 URL appears here.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION });

export async function saveFile(key: string, body: Buffer) {
  return s3.send(
    new PutObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key, Body: body }),
  );
}
