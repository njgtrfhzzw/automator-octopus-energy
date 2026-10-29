/**
 * Send an email via AWS SES using Signature V4.
 * Uses the AWS JS SDK v3 pattern, but implemented with raw fetch to avoid
 * heavy dependencies in Workers.
 */

interface EmailParams {
  to: string;
  from: string;
  subject: string;
  body: string; // plain text
}

function sha256Hex(message: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(message))
    .then((buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join(""));
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const rawKey: ArrayBuffer = key instanceof Uint8Array ? (key.buffer as ArrayBuffer) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export async function sendEmail(
  params: EmailParams,
  accessKeyId: string,
  secretAccessKey: string,
  region = "us-east-1",
): Promise<void> {
  const { to, from, subject, body } = params;
  const service = "ses";
  const method = "POST";
  const host = `email.${region}.amazonaws.com`;
  const endpoint = `https://${host}/`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payload = `Action=SendEmail&` +
    `Destination.ToAddresses.member.1=${encodeURIComponent(to)}&` +
    `Message.Subject.Data=${encodeURIComponent(subject)}&` +
    `Message.Body.Text.Data=${encodeURIComponent(body)}&` +
    `Source=${encodeURIComponent(from)}`;

  const contentType = "application/x-www-form-urlencoded";
  const contentHash = await sha256Hex(payload);

  const canonicalRequest = [
    method,
    "/",
    "",
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    "",
    "content-type;host;x-amz-date",
    contentHash,
  ].join("\n");

  const canonicalHash = await sha256Hex(canonicalRequest);

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalHash,
  ].join("\n");

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = Array.from(new Uint8Array(await hmacSha256(signingKey, stringToSign)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`;

  const response = await fetch(endpoint, {
    method,
    headers: {
      "Content-Type": contentType,
      "Host": host,
      "X-Amz-Date": amzDate,
      "Authorization": authorizationHeader,
    },
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SES send failed (${response.status}): ${text}`);
  }
}
