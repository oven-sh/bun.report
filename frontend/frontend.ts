import type { Parse, RemapAPIResponse } from "../lib/parser";

import { parse } from "../lib/parser";
import { parseCacheKey, debounce, escapeHTML as eschtml } from "../lib/util";
import { addrsToHTML } from "./html";

// Bindings
const input = document.querySelector("#in") as HTMLInputElement;
const out = document.querySelector("#out") as HTMLDivElement;
const example = document.querySelector("#example") as HTMLDivElement;

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
let fetched: RemapAPIResponse | null = null;
let remapping_error: string | null = null;

let pending_fetch_ctrl: AbortController | null = null;
let current_fetch_id: number = 0;

// UI framework
function transition(state: UIState, data?: any) {
  if (ui_state === state && ui_state_data === data) return;
  ui_state_data = data;
  screens[(ui_state = state)]();

  example.style.visibility = state === UIState.None ? "visible" : "hidden";
}

// Data fetching framework
async function fetchRemap(
  parse_text: string,
  parse: Parse,
): Promise<RemapAPIResponse | null> {
  // One remap fetch may be in progress. If there are two, cancel the first
  if (pending_fetch_ctrl) {
    pending_fetch_ctrl.abort();
    pending_fetch_ctrl = null;
  }
  let fetch_id = (current_fetch_id = Math.random());

  // Fetch the remap
  pending_fetch_ctrl = new AbortController();
  const response = await fetch("/remap", {
    method: "POST",
    body: parse_text,
    headers: {
      "Content-Type": "application/json",
    },
    signal: pending_fetch_ctrl.signal,
  });
  if (fetch_id !== current_fetch_id) return null;
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}\nPlease try again later.`,
    );
  }

  const remap = await response.json();

  if (remap.error) {
    throw new Error(`${remap.error}`);
  }

  if (fetch_id !== current_fetch_id) return null;
  pending_fetch_ctrl = null;
  fetch_id = 0;
  return remap;
}

// Event Handlers
const onInputChange = debounce(async () => {
  const value = input.value.trim();
  if (!value) {
    transition(UIState.None);
    localStorage.removeItem("bun-remap.input");
    return;
  }

  parsed = await parse(value);
  console.log(parsed);

  if (!parsed) {
    transition(UIState.Invalid);
    localStorage.removeItem("bun-remap.input");
    return;
  }

  localStorage.setItem(
    "bun-remap.input",
    JSON.stringify([Date.now() + 1000 * 60 * 60 * 24 * 3, input.value]),
  );

  transition(UIState.Loading, value);
}, 50);
input.addEventListener("input", onInputChange);

// Local Storage Sync + URL query param
{
  let search = location.search;
  if (search.startsWith("?trace=")) {
    input.value = search.slice(7);
    history.replaceState(null, "", "/");
  } else {
    let existing: any = localStorage.getItem("bun-remap.input");
    if (existing) {
      existing = JSON.parse(existing);
      if (existing[0] > Date.now()) {
        input.value = existing[1];
      } else {
        localStorage.removeItem("bun-remap.input");
      }
    }
  }
  input.value && onInputChange();
}

// Screens
const screens: Record<UIState, () => void> = {
  // When the input box is cleared, clear the output
  [UIState.None]: () => {
    out.innerHTML = "";
  },

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
    fetchRemap(input.value, parsed)
      .then((remap) => {
        if (!remap) return;
        fetched = remap;
        transition(UIState.Fetched);
      })
      .catch((e) => {
        console.error(e);
        remapping_error = e.message;
        transition(UIState.FetchError);
      })
      .finally(() => (fetched_fast = true));

    // wait a tiny bit before showing the placeholder, this will cover for fast internet
    await new Promise((r) => setTimeout(r, 100));
    if (fetched_fast) return;

    const list = addrsToHTML(null!, parsed.addresses)
      .map((l) => `<tr>${l}</tr>`)
      .join("");

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

    const list = addrsToHTML(fetched.commit.oid, fetched.addresses)
      .map((l) => `<tr>${l}</tr>`)
      .join("");

    const issue = fetched.issue
      ? `<a class='button' href="https://github.com/oven-sh/bun/issues/${fetched.issue}" target="_blank">#${fetched.issue}</a>`
      : `<a class="button" href="${reportUrl(input.value)}" target="_blank">File issue on GitHub</a>`;

    out.innerHTML = /* html */ `
      <div class='card'>
        ${cardHead()}
        <table><tbody>${list}</tbody></table>
        ${cardFooter()}
        <div class='spacing'>${issue}</div>
      </div>
    `;
  },

  // When fetch fails, fallback to this screen.
  [UIState.FetchError]: () => {
    parsed = parsed!;
    remapping_error = remapping_error!;
    fetched = null;

    localStorage.removeItem("bun-remap.input");

    out.innerHTML = /* html */ `
      <div class='card'>
        ${cardHead()}
        <pre class='error'><code>Failed to remap stack trace to source code:\n${remapping_error}</code></pre>
        ${cardFooter()}
      </div>
    `;
  },
};

function cardHead() {
  parsed = parsed!;

  return /* html */ `
    <p><code>${eschtml(parsed.message).replace(
    /^panic: /,
    "<strong>panic</strong>: ",
  )}</code></p>
  `;
}

const os_names: { [key: string]: string } = {
  w: "Windows",
  m: "macOS",
  l: "Linux",
};

function cardFooter() {
  parsed = parsed!;

  let { oid } = fetched?.commit ?? {};

  const commit = /* pr
    ? `<a href="https://github.com/oven-sh/bun/pull/${pr.number}" target="_blank">#${pr.number}</a>`
    : */ oid
      ? `<a href="https://github.com/oven-sh/bun/commit/${oid}" target="_blank">${parsed.commitish}</a>`
      : parsed.commitish;

  const arch = parsed.arch.split("_baseline");


  const features = fetched?.features
    ? /* html */ `
        <p><strong>Features:</strong> ${fetched.features.join(', ')}</p>
      `
    : '';

  return /* html */ `
    <p>
      Bun v${addCanarySuffix(fetched ? fetched.version : parsed.version, parsed.is_canary)} <small>(<code>${commit}</code>)</small>
      on ${os_names[parsed.os[0]]} ${arch[0]} ${arch.length > 1 ? "(baseline)" : ""}
    </p>
    ${features}
  `;
}

function reportUrl(str: string) {
  const prefix = "https://bun.report/";
  if (str.startsWith(prefix)) return str;
  return prefix + str;
}

function addCanarySuffix(ver: string, add: boolean | null | undefined) {
  if (!add) return ver;
  if (ver.includes("canary")) return ver;
  return ver + "-canary";
}
