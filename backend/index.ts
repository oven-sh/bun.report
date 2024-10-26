import type { ServeOptions, Server } from "bun";
import { type RemapAPIResponse, parse, type Parse } from "../lib/parser";
import { remap } from "./remap";
import { join } from "node:path";
import { addrsToPlainText, formatMarkdown, os_names } from "../lib/format";
import { garbageCollect, tagIssue } from "./db";
import { escapeHTML, remapCacheKey } from "../lib/util";
import { sendToSentry } from "./sentry";
import { getCommit } from "./git";

process.env.NODE_ENV ||= "development";

const html =
  process.env.NODE_ENV === "production"
    ? await Bun.file(join(import.meta.dir, "index.html")).arrayBuffer()
    : null;

function getPathname(url: URL) {
  let pathname = url.pathname;

  while (pathname.startsWith("//")) {
    pathname = pathname.slice(1);
  }

  if (pathname === "") {
    return "/";
  }

  return pathname;
}

// Server
export default {
  port: 3000,

  fetch(request, server) {
    if (process.env.NODE_ENV === "development") {
      console.log(`${request.method} ${request.url}`);
    }

    if (request.method === "POST") {
      return postRequest(request, server);
    }

    const request_url = new URL(request.url);
    const pathname = getPathname(request_url);

    // Development
    if (process.env.NODE_ENV === "development") {
      if (pathname === "/") {
        return Bun.file(join(import.meta.dir, "../frontend/index.dev.html"))
          .text()
          .then(
            async (text) =>
              new Response(
                text.replaceAll(
                  "%md%",
                  require("marked").parse(
                    await Bun.file(
                      join(import.meta.dir, "../explainer.md")
                    ).text()
                  )
                ),
                {
                  headers: {
                    "Content-Type": "text/html; charset=utf-8",
                  },
                }
              )
          );
      }

      if (pathname === "/frontend.js") {
        return import("../build")
          .then((mod) => mod.build("development"))
          .then((f: any) => new Response(f));
      }

      if (pathname === "/style.css") {
        return new Response(
          Bun.file(join(import.meta.dir, "../frontend/style.css"))
        );
      }
    }
    if (process.env.NODE_ENV === "production") {
      if (pathname === "/") {
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }
    }

    if (pathname === "/favicon.ico") {
      return new Response(
        Bun.file(
          join(
            import.meta.dir,
            process.env.NODE_ENV === "production"
              ? "favicon.ico"
              : "../frontend/favicon.ico"
          )
        )
      );
    }

    // Discord bot crawling
    if (request.headers.get("user-agent")?.includes("discord")) {
      if (pathname.endsWith("/oembed.json")) {
        const str = pathname.slice(1, -12);

        return parse(str).then(async (parsed) => {
          if (!parsed) {
            return new Response("Not found", { status: 404 });
          }

          const arch = parsed.arch.split("_baseline");
          let { oid } =
            (await getCommit(parsed.commitish).catch((_) => null)) ?? {};

          const oembed: { [key: string]: string } = {
            author_name: parsed.message,
            author_url: `${request_url.origin}/${encodeURI(str)}/view`,
            provider_name: `Bun v${parsed.version} (${parsed.commitish}) on ${os_names[parsed.os[0]]} ${arch[0]}${arch.length > 1 ? " (baseline)" : ""}`,
            type: "link",
            version: "1.0",
          };

          if (oid !== undefined) {
            oembed.provider_url = `https://github.com/oven-sh/bun/tree/${oid}`;
          }

          return Response.json(oembed);
        });
      }

      // Respond with the same metadata if user tries to be helpful by adding "/view"
      const str = pathname.endsWith("/view")
        ? pathname.slice(1, -5)
        : pathname.slice(1);

      return parse(str).then(async (parsed) => {
        if (!parsed) {
          return new Response("Not found", { status: 404 });
        }

        let metadata_tags = `<meta name="theme-color" content="#f472b6">
        <meta content="https://bun.sh/logo-square@16px.png" property="og:image">
        <link type="application/json+oembed" href="${request_url.origin}/${encodeURI(str)}/oembed.json" />`;

        try {
          const remapped = await remap(str, parsed);

          const embed_description = addrsToPlainText(
            remapped.commit.oid,
            remapped.addresses
          ).join("\n");

          metadata_tags += `<meta property=og:description content="${escapeHTML(embed_description)}">`;
        } catch (e) {}

        return new Response(metadata_tags, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      });
    }

    if (pathname.endsWith("/view")) {
      return new Response("Not found", {
        status: 307,
        headers: { Location: `/?trace=${pathname.slice(1, -5)}` },
      });
    }

    if (pathname.endsWith("/ack")) {
      const str = pathname.slice(1, -4);
      return parse(str)
        .then(async (parsed) => {
          if (!parsed) {
            if (process.env.NODE_ENV === "development") {
              console.log("Invalid trace string sent for ack");
              console.error(pathname.slice(1, -4));
            }
            return new Response("Not found", { status: 404 });
          }

          remap(str, parsed)
            .then((remap) => {
              return sendToSentry(parsed, remap);
            })
            .catch((e) => {
              if (process.env.NODE_ENV === "development") {
                console.log("Invalid trace string sent for ack");
                console.error(e);
              }
            });

          return new Response("ok");
        })
        .catch((err) => {
          console.log(err);
          return new Response("ok");
        });
    }

    const str = pathname.slice(1);
    return parse(str).then(async (parsed) => {
      if (!parsed) {
        return new Response("Not found", { status: 404 });
      }

      return remapAndRedirect(str, parsed, request.headers);
    });
  },
  error(err) {
    console.log(err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  },
} satisfies ServeOptions;

// Post requests
function postRequest(request: Request, server: Server) {
  const pathname = getPathname(new URL(request.url));

  switch (pathname) {
    case "/remap":
      return postRemap(request, server);
    case "/github-webhook":
      // postGithubWebhook(request, server).catch((err) => {
      //   console.log(err);
      // });
      return new Response("ok");
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function postRemap(request: Request, server: Server) {
  // Validate input body request
  let parsed: Parse;

  const body = await request.text();
  try {
    parsed = (await parse(body))!;
    if (!parsed) throw new Error("Invalid trace string");
  } catch (e) {
    return new Response("Invalid request", { status: 400 });
  }

  // Do the remapping
  try {
    const remapped = await remap(body, parsed);

    return Response.json({
      commit: remapped.commit,
      addresses: remapped.addresses,
      issue: remapped.issue ?? null,
      command: remapped.command,
      version: remapped.version,
      features: remapped.features,
    } satisfies RemapAPIResponse);
  } catch (e) {
    return handleError(e, false);
  }
}

// Disabled: it does not work
// async function postGithubWebhook(request: Request, server: Server) {
//   const body = await request.text();

//   const sig = request.headers.get("x-hub-signature");
//   const event = request.headers.get("x-github-event");
//   const id = request.headers.get("x-github-delivery");

//   if (!sig || !event || !id) {
//     return;
//   }

//   if (!(await verify(process.env.GITHUB_WEBHOOK_SECRET!, sig, body))) {
//     return;
//   }

//   const payload = JSON.parse(body);

//   if (event !== "issues") return;
//   if (payload.action !== "opened") return;
//   const issue = payload.issue;
//   if (!issue) return;
//   const issue_number = issue.number;
//   const issue_body = issue.body;

//   if (!issue_body) return;

//   const match = issue_body.match(/bun\.report:\s*([a-z0-9_/+-]+?)\s*-/);

//   if (match) {
//     const cache_key = match[1];
//     await tagIssue(cache_key, issue_number);
//   }
// }

const default_template = "6-crash-report.yml";
const install_template = "7-install-crash-report.yml";

async function remapAndRedirect(
  parsed_str: string,
  parsed: Parse,
  headers: Headers
) {
  try {
    const remapped = await remap(parsed_str, parsed);

    if (!remapped) {
      return new Response("Failed to remap", { status: 500 });
    }

    let sentryDetails:
      | { id: string }
      | { shortId: string; permalink: string }
      | undefined;

    try {
      sentryDetails = await sendToSentry(parsed, remapped);
    } catch (e) {
      console.error("Failed to send to sentry", e);
    }

    if (remapped.issue) {
      return Response.redirect(
        `https://github.com/oven-sh/bun/issues/${remapped.issue}`,
        307
      );
    }

    const markdown = formatMarkdown(remapped);
    const template =
      remapped.command === "InstallCommand"
        ? install_template
        : default_template;
    let report =
      markdown +
      "\n\n<!-- from bun.report: " +
      remapCacheKey(remapped) +
      " -->";
    if (sentryDetails?.id) {
      const { id } = sentryDetails;
      report += `\n\n<!-- sentry_id: ${id} -->`;
    } else if (sentryDetails?.shortId) {
      const { shortId, permalink } = sentryDetails;
      report += `\n\nFor Bun's team:\n\nSentry Issue: **[${shortId}](${permalink})**\nFixes ${shortId}`;
    }
    const url = `https://github.com/oven-sh/bun/issues/new?labels=crash&template=${template}&remapped_trace=${encodeURIComponent(
      report
    )}`;

    return Response.redirect(url, 307);
  } catch (e) {
    return handleError(e, true);
  }
}

function handleError(e: any, visual: boolean) {
  switch (e?.code) {
    case "MissingToken":
      return Response.json({ error: "Missing GITHUB_TOKEN" });
    case "DebugInfoUnavailable":
      if (process.env.NODE_ENV === "development") {
        console.error(e);
      }
      return Response.json({
        error: "Could not find debug info for this version of Bun.",
      });
    case "PdbAddr2LineFailed":
      console.error(e);
      return Response.json({
        error: "Failed to remap addresses in debug info.",
      });
    default:
      console.error(e);
      return new Response("Internal server error", { status: 500 });
  }
}

setInterval(
  () => {
    garbageCollect();
  },
  1000 * 60 * 60 * 24 * 7
);

console.log("bun.report");
console.log(
  "Discord Webhook: " +
    (process.env.DISCORD_WEBHOOK_URL ? "enabled" : "disabled")
);
console.log("Sentry: " + (process.env.SENTRY_DSN ? "enabled" : "disabled"));
console.log(
  "GitHub Webhook: " +
    (process.env.GITHUB_WEBHOOK_SECRET ? "enabled" : "disabled")
);

if (!process.env.BUN_DOWNLOAD_BASE) {
  console.error("BUN_DOWNLOAD_BASE is not set");
  process.exit(1);
}
