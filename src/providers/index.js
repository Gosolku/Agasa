// The one place that knows how to talk to a model.
//
// This has been Groq, then OpenRouter, then Gemini. The interface below is
// what stays put through the next swap: a provider is an object that turns
// a list of turns into an async stream of normalised events. Adding one means
// writing a file next to gemini.js and adding it to PROVIDERS — no route,
// protocol or front-end change.

import { gemini } from "./gemini.js";
import { cfAi } from "./cf-ai.js";

/**
 * @typedef {object} Turn
 * @property {"user"|"assistant"} role
 * @property {string} text
 *
 * @typedef {object} ChatRequest
 * @property {Turn[]} messages   full turn list, oldest first, user turn last
 * @property {string} system     system instruction
 * @property {object} env        Worker env, for credentials
 * @property {AbortSignal} [signal]
 *
 * @typedef {{type:"delta", text:string}
 *   | {type:"usage", tokens:{in:number, out:number}}
 *   | {type:"done", reason:string}
 *   | {type:"error", message:string, detail?:string}} ProviderEvent
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {string} model
 * @property {(env:object) => boolean} configured
 * @property {(req:ChatRequest) => AsyncIterable<ProviderEvent>} stream
 */

/** @type {Record<string, Provider>} */
const PROVIDERS = {
  [gemini.id]: gemini,
  [cfAi.id]: cfAi,
};

export const DEFAULT_PROVIDER = gemini.id;

/**
 * Pick the active provider.
 *
 * Order: an explicit `env.PROVIDER` wins, then Workers AI if its binding is
 * present, then Gemini. The binding is the signal because it cannot be there
 * by accident — it is declared in wrangler.jsonc — and a deployment that has
 * it has an allowance measured in thousands rather than in twenties.
 *
 * `env.PROVIDER` stays the override in both directions: set it to "gemini" on
 * a deployment that has the AI binding and Gemini answers anyway, which is the
 * escape hatch for "the small model got this wrong, use the good one". An
 * unknown value falls back rather than failing, so a typo in a dashboard
 * variable can't take the site down.
 */
export function getProvider(env) {
  const requested = env && env.PROVIDER;
  if (requested && PROVIDERS[requested]) return PROVIDERS[requested];
  if (cfAi.configured(env)) return PROVIDERS[cfAi.id];
  return PROVIDERS[DEFAULT_PROVIDER];
}

export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
  }));
}
