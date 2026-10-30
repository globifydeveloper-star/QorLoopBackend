import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import "dotenv/config";

const client = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const Bucket = process.env.S3_BUCKET;
const Key = "tests/qorloop-storage-test.txt";
const content = "Qorloop storage test successful";

try {
  await client.send(new PutObjectCommand({
    Bucket,
    Key,
    Body: content,
    ContentType: "text/plain",
  }));
  console.log("Upload successful");

  const result = await client.send(new GetObjectCommand({ Bucket, Key }));
  const downloaded = await result.Body.transformToString();

  if (downloaded !== content) {
    throw new Error("Downloaded content does not match uploaded content");
  }

  console.log("Download and content verification successful");

  await client.send(new DeleteObjectCommand({ Bucket, Key }));
  console.log("Test object deleted successfully");
} catch (error) {
  console.error("Storage test failed:", error.message);
  process.exitCode = 1;
}
