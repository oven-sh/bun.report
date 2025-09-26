import type { Server } from "bun";
import { S3Client } from "bun";
import archiver from "archiver";
import { PassThrough } from "stream";

const s3 = new S3Client({
  endpoint: process.env.FEEDBACK_BUCKET_ENDPOINT,
  bucket: process.env.FEEDBACK_BUCKET,
  accessKeyId: process.env.FEEDBACK_ACCESS_KEY_ID,
  secretAccessKey: process.env.FEEDBACK_SECRET_ACCESS_KEY_ID,
});

const DISCORD_WEBHOOK_URL = process.env.FEEDBACK_DISCORD_WEBHOOK_URL;

interface FeedbackData {
  email: string;
  message: string;
  platform?: string;
  arch?: string;
  bunRevision?: string;
  hardwareConcurrency?: string;
  bunVersion?: string;
  bunBuild?: string;
  availableMemory?: string;
  totalMemory?: string;
  osVersion?: string;
  osRelease?: string;
  clientId?: string;
  serverId?: string;
  docker?: string;
  localIPSupport?: string;
  remoteIPSupport?: string;
  remoteFilesystem?: string;
  projectId?: string;
  ipAddress?: string;
}

async function createTarball(formData: FormData, serverId: string): Promise<Uint8Array> {
  return new Promise(async (resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = new PassThrough();

    stream.on("data", (chunk) => {
      chunks.push(new Uint8Array(chunk));
    });

    stream.on("end", () => {
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(result);
    });

    const archive = archiver("tar", { gzip: true });

    archive.on("error", reject);

    archive.pipe(stream);

    // Extract form data for feedback.json
    const feedbackData: FeedbackData = {
      email: formData.get("email") as string,
      message: formData.get("message") as string,
      platform: formData.get("platform") as string,
      arch: formData.get("arch") as string,
      bunRevision: formData.get("bunRevision") as string,
      hardwareConcurrency: formData.get("hardwareConcurrency") as string,
      bunVersion: formData.get("bunVersion") as string,
      bunBuild: formData.get("bunBuild") as string,
      availableMemory: formData.get("availableMemory") as string,
      totalMemory: formData.get("totalMemory") as string,
      osVersion: formData.get("osVersion") as string,
      osRelease: formData.get("osRelease") as string,
      clientId: formData.get("id") as string,
      serverId: serverId,
      docker: formData.get("docker") as string,
      localIPSupport: formData.get("localIPSupport") as string,
      remoteIPSupport: formData.get("remoteIPSupport") as string,
      remoteFilesystem: formData.get("remoteFilesystem") as string,
      projectId: formData.get("projectId") as string,
    };

    // Add feedback.json
    const feedbackJson = JSON.stringify(feedbackData, null, 2);
    archive.append(feedbackJson, { name: "feedback.json" });

    // Add feedback.txt if message exists
    if (feedbackData.message) {
      archive.append(feedbackData.message, { name: "feedback.txt" });
    }

    // Handle file uploads
    const files = formData.getAll("files[]");
    for (const file of files) {
      if (file instanceof File) {
        const buffer = Buffer.from(await file.arrayBuffer());
        archive.append(buffer, { name: file.name });
      }
    }

    archive.finalize();
  });
}

async function uploadToS3(
  tarball: Uint8Array,
  clientId: string,
  serverId: string,
  projectId?: string,
): Promise<string> {
  const prefix = projectId || "feedback";
  const key = `${prefix}/${clientId}-${serverId}.tar.gz`;

  await s3.write(key, tarball);

  // Generate presigned URL with 7 day expiry
  const presignedUrl = s3.presign(key, {
    expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
  });

  return presignedUrl;
}

async function sendToDiscord(
  feedbackData: FeedbackData,
  tarballUrl: string | null,
  fileList: string[],
) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("Discord webhook URL not configured");
    return;
  }

  const form = new FormData();
  const messageComponents = [];

  // Header
  messageComponents.push({
    type: 10,
    content: `## <${feedbackData.email || "Unknown User"}>`,
  });

  // System info in one line
  const sysInfo = [];
  if (feedbackData.bunVersion) sysInfo.push(`Bun v${feedbackData.bunVersion}`);
  if (feedbackData.platform) sysInfo.push(feedbackData.platform);
  if (feedbackData.arch) sysInfo.push(feedbackData.arch);
  if (feedbackData.docker === "true") sysInfo.push("Docker");
  if (feedbackData.remoteFilesystem === "true") sysInfo.push("Remote FS");

  if (sysInfo.length > 0) {
    messageComponents.push({
      type: 10,
      content: "-# " + sysInfo.join(" ") + "\n",
    });
  }

  // Message
  if (feedbackData.message) {
    messageComponents.push({
      type: 10,
      content: feedbackData.message + "\n",
    });
  }

  // show some crticial information if relevent (ie high mem usage)
  let criticalInfo = [];
  if (feedbackData.availableMemory && feedbackData.totalMemory) {
    const availableMemory = parseInt(feedbackData.availableMemory);
    const totalMemory = parseInt(feedbackData.totalMemory);
    const memoryUsage = (availableMemory / totalMemory) * 100;
    if (memoryUsage > 80) {
      criticalInfo.push(`**Memory Usage:** ${memoryUsage.toFixed(2)}%`);
    }
  }
  if (criticalInfo.length > 0) {
    messageComponents.push({
      type: 10,
      content: criticalInfo.join(" ") + "\n",
    });
  }

  // File tree
  if (fileList.length > 0) {
    const parts = [];
    parts.push("```");
    const sortedFiles = fileList.sort();

    // Build simple ASCII tree
    for (let i = 0; i < sortedFiles.length && i < 20; i++) {
      const isLast = i === sortedFiles.length - 1 || i === 19;
      const prefix = isLast ? "└── " : "├── ";
      parts.push(prefix + sortedFiles[i]);
    }
    if (sortedFiles.length > 20) {
      parts.push(`└── ... and ${sortedFiles.length - 20} more`);
    }
    parts.push("```");
    parts.push("");

    messageComponents.push({
      type: 10,
      content: parts.join("\n"),
    });
  }

  // Footer with IDs and IP
  let footerParts = [];
  if (feedbackData.clientId && feedbackData.serverId) {
    if (tarballUrl) {
      footerParts.push(
        `**ID:** [${feedbackData.clientId}-${feedbackData.serverId}](<${tarballUrl}> "Download Archive")`,
      );
    } else {
      footerParts.push(`**ID:** ${feedbackData.clientId}-${feedbackData.serverId}`);
    }
  }
  if (feedbackData.projectId) {
    footerParts.push(`**Project:** ${feedbackData.projectId}`);
  }
  if (feedbackData.ipAddress && feedbackData.ipAddress !== "unknown") {
    footerParts.push(`**IP:** ${feedbackData.ipAddress}`);
  }

  // Upload archive to discord
  if (tarballUrl) {
    const tarballFilename = "archive.tar.gz";
    messageComponents.push({
      type: 13,
      file: {
        url: `attachment://${tarballFilename}`,
      },
    });
    form.append("file", await (await fetch(tarballUrl)).blob(), tarballFilename);
  }

  // Show current timestamp
  // footerParts.push(`<t:${Math.floor(Date.now() / 1000)}:R>`);

  if (footerParts.length > 0) {
    messageComponents.push({
      type: 10,
      content: "-# " + footerParts.join("\n-# "),
    });
  }

  // Create webhook payload
  const webhookPayload = {
    username: "Bun Feedback Bot",
    flags: 1 << 15,
    allowed_mentions: {},
    components: [
      {
        type: 17,
        accent_color: 0x5865f2, // Discord blurple,
        components: messageComponents,
      },
    ],
  };
  form.append("payload_json", JSON.stringify(webhookPayload));

  // Send webhook
  const webhookUrl = new URL(DISCORD_WEBHOOK_URL);
  webhookUrl.searchParams.set("wait", "true");
  webhookUrl.searchParams.set("with_components", "true");

  const response = await fetch(webhookUrl, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    console.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
    const text = await response.text().catch(() => "");
    if (text) {
      // if webhook fails, try to let us know but still send the feedback
      const errorForm = new FormData();
      errorForm.append(
        "payload_json",
        JSON.stringify({
          content: `**Error:** ${text}`,
          allowed_mentions: {},
        }),
      );
      errorForm.append(
        "file[1]",
        new Blob([JSON.stringify(webhookPayload, null, 2)]),
        "discord-payload.json",
      );
      errorForm.append(
        "file[2]",
        new Blob([JSON.stringify({ feedbackData, tarballUrl, fileList }, null, 2)]),
        "inputs.json",
      );
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        body: errorForm,
      });

      console.error("Discord webhook error:", text);
    }
  }
}

export async function onFeedbackRequest(request: Request, server: Server) {
  try {
    const formData = await request.formData();

    // Validate client ID
    const clientId = formData.get("id") as string;
    if (!clientId) {
      return new Response("Client ID is required", { status: 400 });
    }

    // Generate server-side ID
    const serverId = Bun.randomUUIDv7();

    // Extract IP address using server.requestIP
    const ipAddress = server.requestIP(request)?.address || "unknown";

    // Log the feedback request
    console.log(
      `[Feedback] Received feedback ${serverId} (client: ${clientId}) from ${formData.get("email")} (${ipAddress})`,
    );

    // Check if there are any files to upload
    const files = formData.getAll("files[]");
    const fileList: string[] = [];
    for (const file of files) {
      if (file instanceof File) {
        fileList.push(file.name);
      }
    }
    const hasFiles = fileList.length > 0;
    const hasMessage = !!formData.get("message");

    let tarballUrl: string | null = null;

    if (hasFiles || hasMessage) {
      // Create tarball in memory
      const tarball = await createTarball(formData, serverId);

      // Upload to S3 and get presigned URL
      const projectId = formData.get("projectId") as string;
      tarballUrl = await uploadToS3(tarball, clientId, serverId, projectId);
      console.log(`[Feedback] Uploaded archive for ${clientId}-${serverId}`);
    } else {
      console.log(`[Feedback] No files or message to archive for ${clientId}-${serverId}`);
    }

    // Extract feedback data for Discord
    const feedbackData: FeedbackData = {
      email: formData.get("email") as string,
      message: formData.get("message") as string,
      platform: formData.get("platform") as string,
      arch: formData.get("arch") as string,
      bunRevision: formData.get("bunRevision") as string,
      hardwareConcurrency: formData.get("hardwareConcurrency") as string,
      bunVersion: formData.get("bunVersion") as string,
      bunBuild: formData.get("bunBuild") as string,
      availableMemory: formData.get("availableMemory") as string,
      totalMemory: formData.get("totalMemory") as string,
      osVersion: formData.get("osVersion") as string,
      osRelease: formData.get("osRelease") as string,
      clientId: clientId,
      serverId: serverId,
      docker: formData.get("docker") as string,
      localIPSupport: formData.get("localIPSupport") as string,
      remoteIPSupport: formData.get("remoteIPSupport") as string,
      remoteFilesystem: formData.get("remoteFilesystem") as string,
      projectId: formData.get("projectId") as string,
      ipAddress: ipAddress,
    };

    // Send to Discord
    await sendToDiscord(feedbackData, tarballUrl, fileList);
    console.log(`[Feedback] Sent Discord notification for ${serverId}`);

    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error("[Feedback] Error processing feedback:", error);
    return new Response("Internal server error", { status: 500 });
  }
}
