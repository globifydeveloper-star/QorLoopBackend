import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
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

const result = await client.send(new ListBucketsCommand({}));
console.log("Buckets:", result.Buckets?.map(b => b.Name));
