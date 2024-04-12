import type { Parse, RemapResponse } from '../lib/parser';

import { parse } from '../lib/parser';
import { cacheKey, capitalize, debounce, escapeHTML as eschtml } from '../lib/util';
import { addrsToHTML, placeholderAddrsToHTML } from './formatting';

// Bindings
const input = document.querySelector('#in') as HTMLInputElement;
const out = document.querySelector('#out') as HTMLDivElement;
const store = await caches.open('bun-remap');

// UI State
enum UIState {
  None,
  Invalid,
  Loading,
  Fetched,
  FetchError,
}

let ui_state: UIState = UIState.None;
let ui_state_data: any = null;

let parsed: Parse | null = null;
let fetched: RemapResponse | null = null
let remapping_error: string | null = null;

let pending_fetch_ctrl: AbortController | null = null;
let current_fetch_id: number = 0;

// UI framework
function transition(state: UIState, data?: any) {
  if (ui_state === state && ui_state_data === data)
    return;
  ui_state_data = data;
  screens[ui_state = state]();
}

// Data fetching framework
async function fetchRemap(parse: Parse): Promise<RemapResponse | null> {
  // One remap fetch may be in progress. If there are two, cancel the first
  if (pending_fetch_ctrl) {
    pending_fetch_ctrl.abort();
    pending_fetch_ctrl = null;
  }
  let fetch_id = current_fetch_id = Math.random();

  // Use a cached entry
  const cached_request = new Request(`/remap/${cacheKey(parse)}`);
  const cached = await store.match(cached_request, {});
  if (cached) return cached.json();
  if (fetch_id !== current_fetch_id) return null;

  // Fetch the remap
  pending_fetch_ctrl = new AbortController();
  const response = await fetch('/remap', {
    method: 'POST',
    body: JSON.stringify({
      addresses: parse.addresses,
      os: parse.os,
      arch: parse.arch,
      version: parse.version,
      commitish: parse.commitish,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    signal: pending_fetch_ctrl.signal
  });
  if (fetch_id !== current_fetch_id) return null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\nPlease try again later.`);
  }

  const remap = await response.json();

  if (remap.error) {
    throw new Error(`${remap.error}`);
  }

  location.host.startsWith('localhost') ||
    store.put(cached_request, new Response(JSON.stringify(remap), {
      headers: {
        'Cache-Control': `public, max-age=${60 * 60 * 24 * 3}'`,
      },
    }));

  if (fetch_id !== current_fetch_id) return null;
  pending_fetch_ctrl = null;
  fetch_id = 0;
  return remap;
}

// Event Handlers
const onInputChange = debounce(async () => {
  const value = input.value;
  if (!value) {
    transition(UIState.None);
    localStorage.removeItem('bun-remap.input');
    return;
  }

  parsed = await parse(value);
  console.log(parsed);

  if (!parsed) {
    transition(UIState.Invalid);
    localStorage.removeItem('bun-remap.input');
    return;
  }

  localStorage.setItem('bun-remap.input', JSON.stringify([Date.now() + (1000 * 60 * 60 * 24 * 3), input.value]));

  transition(UIState.Loading, value);
}, 50);
input.addEventListener('input', onInputChange);

// Local Storage Sync + URL query param
{
  let search = location.search;
  if (search.startsWith('?trace=')) {
    input.value = search.slice(7);
    history.replaceState(null, document.title, location.pathname);
  } else {
    let existing: any = localStorage.getItem('bun-remap.input');
    if (existing) {
      existing = JSON.parse(existing)
      if (existing[0] > Date.now()) {
        input.value = existing[1];
      } else {
        localStorage.removeItem('bun-remap.input');
      }
    }
  }
  input.value && onInputChange();
}

// Screens
const screens: Record<UIState, () => void> = {
  // When the input box is cleared, clear the output
  [UIState.None]: () => out.innerHTML = '',

  // When the input is valid, show that in an error message
  [UIState.Invalid]: () => {
    out.innerHTML = /* html */ `
      <article><p class='error'>The input string is not a valid Bun Trace String.</p></article>
    `;
  },

  // When the input is loading, show placeholder UI with what we already know.
  [UIState.Loading]: async () => {
    // btw, these 'x = x!' marks tell typescript that `parsed` is not null.
    parsed = parsed!;
    fetched = null;

    let fetched_fast = false;
    fetchRemap(parsed)
      .then(remap => {
        if (!remap) return;
        fetched = remap;
        transition(UIState.Fetched);
      })
      .catch(e => {
        remapping_error = e.message;
        transition(UIState.FetchError);
      })
      .finally(() =>
        fetched_fast = true
      );

    // wait a tiny bit before showing the placeholder, this will cover for fast internet
    await new Promise(r => setTimeout(r, 100));
    if (fetched_fast) return;

    const list = placeholderAddrsToHTML(parsed.addresses).map(l => `<tr>${l}</tr>`).join('');

    out.innerHTML = /* html */ `
      <div class='card'>
        ${cardHead()}
        <table><tbody>${list}</tbody></table>
        ${cardFooter()}
      </div>
    `;
  },

  // This is the fetched state
  [UIState.Fetched]: () => {
    parsed = parsed!;
    fetched = fetched!;

    const list = addrsToHTML(fetched.commit, fetched.addresses).map(l => `<tr>${l}</tr>`).join('');

    out.innerHTML = /* html */ `
      <div class='card'>
        ${cardHead()}
        <table><tbody>${list}</tbody></table>
        ${cardFooter()}
      </div>
    `;
  },

  // When fetch fails, fallback to this screen.
  [UIState.FetchError]: () => {
    parsed = parsed!;
    remapping_error = remapping_error!;
    fetched = null;

    localStorage.removeItem('bun-remap.input');

    out.innerHTML = /* html */ `
      <div class='card'>
        ${cardHead()}
        <pre class='error'><code>Failed to remap stack trace to source code:\n${remapping_error}</code></pre>
        ${cardFooter()}
      </div>
    `;
  }
};

function cardHead() {
  parsed = parsed!;

  return /* html */ `
    <p><code>${eschtml(parsed.message).replace(/^panic: /, '<strong>panic</strong>: ')}</code></p>
  `
}

function cardFooter() {
  parsed = parsed!;

  const commit = fetched
    ? `<a href="https://github.com/oven-sh/bun/commit/${fetched.commit}" target="_blank">${parsed.commitish}</a>`
    : parsed.commitish;

  const arch = parsed.arch.split('_baseline');

  return /* html */ `
    <p>
      Bun v${parsed.version} <small>(<code>${commit}</code>)</small>
      on ${capitalize(parsed.os)} ${arch[0]} ${arch.length > 1 ? '(baseline)' : ''}
    </p>
  `;
}
