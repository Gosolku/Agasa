// The tool registry, server side.
//
// Nothing is declared here. Everything comes out of public/js/manifest.json,
// which wrangler bundles into the Worker at build time — so the list the model
// is offered and the list the browser can execute are literally the same
// bytes. That is the property worth having: a tool cannot be advertised to
// Gemini without the interface shipping a handler for it, because both sides
// are reading one file.
//
// Every incoming function call is checked against this registry before it is
// relayed anywhere. A name that isn't here is dropped — the whitelist is the
// injection guard, and it must stay a whitelist rather than a blocklist.

import manifest from "../../public/js/manifest.json";

const TOOLS = manifest.tools || [];
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The `tools` block for a Gemini request. */
export function toolDeclarations() {
  return [{ functionDeclarations: TOOLS.map((tool) => tool.declaration) }];
}

/**
 * The same declarations with no vendor envelope around them — `{ name,
 * description, parameters }`, which is the shape both Google and the
 * OpenAI-style APIs are wrapping in the first place.
 *
 * A provider that isn't Gemini takes this and puts its own envelope on, rather
 * than unpicking Google's. Still one list, still from the manifest.
 */
export function toolFunctions() {
  return TOOLS.map((tool) => tool.declaration);
}

export function findTool(name) {
  return BY_NAME.get(name);
}

/** Served at /api/meta so the client can assert it implements every
 *  client-side tool the model will be told about, and complain if not. */
export function toolManifest() {
  return {
    version: manifest.version,
    modules: (manifest.modules || []).map((m) => m.id),
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      capability: tool.capability,
      side: tool.side,
      handler: tool.handler,
    })),
  };
}
