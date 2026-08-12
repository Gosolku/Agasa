// The one place that knows how to talk to a model.
//
// This has been Groq, then OpenRouter, then Gemini. The interface below is
// what stays put through the next swap: a provider is an object that turns
// a list of turns into an async stream of normalised events. Adding one means
// writing a file next to gemini.js and adding it to PROVIDERS — no route,
// protocol or front-end change.

import { gemini } from "./gemini.js";

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
};

export const DEFAULT_PROVIDER = gemini.id;

/**
 * Pick the active provider. `env.PROVIDER` lets a deploy switch without a code
 * change once there is more than one — an unknown value falls back rather than
 * failing, so a typo in a dashboard variable can't take the site down.
 */
export function getProvider(env) {
  const requested = (env && env.PROVIDER) || DEFAULT_PROVIDER;
  return PROVIDERS[requested] || PROVIDERS[DEFAULT_PROVIDER];
}

export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    model: p.model,
  }));
}
