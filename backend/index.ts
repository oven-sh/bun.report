import type { ServeOptions, Server } from 'bun';
import { type RemapAPIResponse, type ParsedAddress, parse, type Parse } from '../lib/parser';
import { remap } from './remap';
import assert from 'node:assert';
import { join } from 'node:path';
import { addrsToPlainText, formatMarkdown } from '../lib/format';
import { garbageCollect, tagIssue } from './db';
import { verify } from '@octokit/webhooks-methods';
import { escapeHTML, remapCacheKey } from '../lib/util';

const html = process.env.NODE_ENV === 'production'
  ? await Bun.file(join(import.meta.dir, 'index.html')).arrayBuffer()
  : null;

// Server
export default {
  port: 3000,

  fetch(request, server) {
    if (request.method === 'POST') {
      return postRequest(request, server);
    }

    const { pathname } = new URL(request.url);

    // Development
    if (process.env.NODE_ENV === 'development') {
      if (pathname === '/') {
        return Bun.file(join(import.meta.dir, '../frontend/index.dev.html'))
          .text()
          .then(async (text) =>
            new Response(text.replaceAll('%md%',
              require('marked').parse(
                await Bun.file(join(import.meta.dir, '../explainer.md')).text()
              )
            ), {
              headers: {
                'Content-Type': 'text/html; charset=utf-8'
              }
            })
          );
      }

      if (pathname === '/frontend.js') {
        return import('../build')
          .then(mod => mod.build('development'))
          .then((f: any) => new Response(f));
      }

      if (pathname === '/style.css') {
        return new Response(Bun.file(join(import.meta.dir, '../frontend/style.css')));
      }
    }
    if (process.env.NODE_ENV === 'production') {
      if (pathname === '/') {
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8'
          }
        });
      }
    }

    if (pathname === '/favicon.ico') {
      return new Response(Bun.file(join(import.meta.dir, process.env.NODE_ENV === 'production' ? 'favicon.ico' : '../frontend/favicon.ico')));
    }

    if (pathname.endsWith('/view')) {
      return new Response('Not found', { status: 307, headers: { Location: `/?trace=${pathname.slice(1, -5)}` } });
    }

    if (pathname.endsWith('/ack')) {
      return parse(pathname.slice(1, -4))
        .then(async (parsed) => {
          if (!parsed) {
            return new Response('Not found', { status: 404 });
          }

          remap(parsed)
            .then(() => { })
            .catch(() => { });

          return new Response('ok');
        });
    }

    return parse(pathname.slice(1))
      .then(async (parsed) => {
        if (!parsed) {
          return new Response('Not found', { status: 404 });
        }

        const is_discord_bot = request.headers.get('user-agent')?.includes('discord') ?? false;

        return remapAndRedirect(parsed, is_discord_bot);
      });
  },
} satisfies ServeOptions;

// Post requests
function postRequest(request: Request, server: Server) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, '');

  switch (pathname) {
    case '/remap':
      return postRemap(request, server);
    case '/github-webhook':
      postGithubWebhook(request, server);
      return new Response('ok');
    default:
      return new Response('Not found', { status: 404 });
  }
}

async function postRemap(request: Request, server: Server) {
  // Validate input body request
  let addresses: ParsedAddress[] = [];
  let os: 'windows' | 'macos' | 'linux';
  let arch: 'x86_64' | 'aarch64';
  let version: string;
  let commitish: string;
  let message: string;
  let command: string;

  const body: unknown = await request.json();
  try {
    assert(typeof body === 'object' && body && !Array.isArray(body));

    assert('addresses' in body);
    assert(Array.isArray(body.addresses));
    for (const addr of body.addresses) {
      assert('address' in addr);
      assert(typeof addr.address === 'number');
      assert(Number.isFinite(addr.address) && addr.address >= 0);
      assert('object' in addr);
      assert(typeof addr.object === 'string');
      addresses.push({ address: addr.address, object: addr.object });
    }

    assert('os' in body);
    assert(body.os === 'macos' || body.os === 'linux' || body.os === 'windows');
    os = body.os;

    assert('arch' in body);
    assert(body.arch === 'x86_64' || body.arch === 'aarch64');
    arch = body.arch;

    assert('version' in body);
    assert(typeof body.version === 'string');
    assert(/^\d+\.\d+\.\d+$/.test(body.version));
    version = body.version;

    assert('commitish' in body);
    assert(typeof body.commitish === 'string');
    assert(body.commitish.length === 7);
    commitish = body.commitish;

    assert('message' in body);
    assert(typeof body.message === 'string');
    message = body.message;

    assert('command' in body);
    assert(typeof body.command === 'string');
    command = body.command;
  } catch (e) {
    return new Response('Invalid request', { status: 400 });
  }

  // Do the remapping
  try {
    const remapped = await remap({
      addresses,
      os,
      arch,
      version,
      commitish,
      message,
      command,
    });

    return Response.json({
      commit: remapped.commit,
      addresses: remapped.addresses,
      issue: remapped.issue ?? null,
      command: remapped.command,
    } satisfies RemapAPIResponse);
  } catch (e) {
    return handleError(e, false);
  }
}

async function postGithubWebhook(request: Request, server: Server) {
  const body = await request.text();

  const sig = request.headers.get('x-hub-signature');
  const event = request.headers.get('x-github-event');
  const id = request.headers.get('x-github-delivery');

  if (!sig || !event || !id) {
    return new Response('Missing headers', { status: 400 });
  }

  if (!await verify(process.env.GITHUB_WEBHOOK_SECRET!, sig, body)) {
    return new Response('Invalid signature', { status: 400 });
  }

  const payload = JSON.parse(body);

  if (event !== 'issues') return;
  if (payload.action !== 'opened') return;
  const issue = payload.issue;
  if (!issue) return;
  const issue_number = issue.number;
  const issue_body = issue.body;

  if (!issue_body) return;

  const match = issue_body.match(/bun\.report:\s*([a-z0-9_/+-]+?)\s*-/);

  if (match) {
    const cache_key = match[1];
    await tagIssue(cache_key, issue_number);
  }
}

const template = '6-crash-report.yml';

async function remapAndRedirect(parsed: Parse, is_discord_bot: boolean) {
  try {
    const remapped = await remap(parsed);

    if (!remapped) {
      return new Response('Failed to remap', { status: 500 });
    }

    if (remapped.issue) {
      return Response.redirect(`https://github.com/oven-sh/bun/issues/${remapped.issue}`, 307);
    }

    if (is_discord_bot) {
      const embed_title = remapped.message;
      const embed_description = addrsToPlainText(remapped.commit.oid, remapped.addresses).join('\n');

      return new Response(`<meta property=og:title content="${escapeHTML(embed_title)}">
<meta property=og:description content="${escapeHTML(embed_description)}">
`, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        }
      });
    }

    const markdown = formatMarkdown(remapped);
    const report = markdown + '\n\n<!-- from bun.report: ' + remapCacheKey(remapped) + ' -->';
    const url = `https://github.com/oven-sh/bun/issues/new?labels=bug,crash&template=${template}&remapped_trace=${encodeURIComponent(report)}`;

    return Response.redirect(url, 307);
  } catch (e) {
    return handleError(e, true);
  }
}

function handleError(e: any, visual: boolean) {
  switch (e?.code) {
    case 'MissingToken':
      return Response.json({ error: 'Missing GITHUB_TOKEN' });
    case 'DebugInfoUnavailable':
      if (process.env.NODE_ENV === 'development') {
        console.error(e);
      }
      return Response.json({ error: 'Could not find debug info for this version of Bun.' });
    case 'PdbAddr2LineFailed':
      console.error(e);
      return Response.json({ error: 'Failed to remap addresses in debug info.' });
    default:
      console.error(e);
      return new Response('Internal server error', { status: 500 })
  }
}

setInterval(() => {
  garbageCollect();
}, 1000 * 60 * 60 * 24 * 7);
