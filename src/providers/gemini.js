// Gemini, behind the provider interface in ./index.js.
//
// Everything Google-shaped is contained in this file: the URL, the `contents`
// array, the SSE envelope, `candidates[0].content.parts`, and the spelling of
// functionCall / functionResponse. Nothing outside it knows any of that.

import { toolDeclarations } from "../tools/index.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export const gemini = {
  id: "gemini",
  label: "Gemini",
  model: "gemini-flash-latest",

  configured: (env) => Boolean(env && env.GEMINI_API_KEY),

  async *stream({ messages, system, tools, env, signal }) {
    const contents = messages.map(toContent);

    const body = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
    };

    // Declarations come from the manifest via the registry, not from an array
    // in this file. A caller may still pass its own — that is how a future
    // provider test runs with a cut-down tool set — but the default is
    // whatever the manifest currently says, so adding a tool is one edit.
    const declared = tools && tools.length ? tools : toolDeclarations();
    if (declared.length && declared[0].functionDeclarations.length) {
      body.tools = declared;
      // AUTO, not ANY: the model must stay free to answer in words. Forcing a
      // call means every "what do you think?" gets answered with a UI action.
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    let res;
    try {
      res = await fetch(
        `${ENDPOINT}/${this.model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }
      );
    } catch (err) {
      yield {
        type: "error",
        message: "Could not reach Gemini.",
        detail: String(err && err.message ? err.message : err).slice(0, 300),
      };
      return;
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      yield {
        type: "error",
        message: `Gemini refused the request (${res.status}).`,
        detail: extractApiMessage(detail),
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokens = null;
    let reason = "stop";
    // Calls arrive mid-stream but are only useful complete, so they are held
    // back and emitted as one event once the stream has finished. Emitting
    // them as they land would mean the caller could start executing call one
    // while call two was still being written.
    const calls = [];

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Keep the trailing fragment — an SSE frame can be split across reads.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let chunk;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // a frame we couldn't parse is not worth killing the turn
          }

          const candidate = chunk.candidates && chunk.candidates[0];
          const parts = (candidate && candidate.content && candidate.content.parts) || [];

          const text = parts.map((p) => p.text || "").join("");
          if (text) yield { type: "delta", text };

          for (const part of parts) {
            if (part.functionCall && part.functionCall.name) {
              calls.push({
                name: String(part.functionCall.name),
                args: part.functionCall.args || {},
                // This model thinks before it calls, and the signature is its
                // receipt for having done so. It has to be handed back with
                // the call when the turn is replayed or the next request is
                // rejected outright — see toContent() below.
                signature: part.thoughtSignature || null,
              });
            }
          }

          if (candidate && candidate.finishReason) {
            reason = String(candidate.finishReason).toLowerCase();
          }

          // Usage arrives on the last chunks; keep overwriting so we end with
          // the final figures rather than a partial count.
          const meta = chunk.usageMetadata;
          if (meta) {
            tokens = {
              in: meta.promptTokenCount || 0,
              out: meta.candidatesTokenCount || 0,
            };
          }
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: "The connection to Gemini dropped mid-answer.",
        detail: String(err && err.message ? err.message : err).slice(0, 300),
      };
      return;
    }

    if (tokens) yield { type: "usage", tokens };
    if (calls.length) yield { type: "tool_call", calls };
    yield { type: "done", reason: calls.length ? "tool_call" : reason };
  },
};

/* ── turn → Google's `contents` entry ───────────────────────────── */

function toContent(turn) {
  if (turn.role === "tool") {
    // Google has no "tool" role. Function results are sent back as a user
    // turn whose parts are functionResponse objects — that is the shape, odd
    // as it looks, and `response` has to be an object rather than a string.
    return {
      role: "user",
      parts: turn.responses.map((r) => ({
        functionResponse: {
          name: r.name,
          response: r.response && typeof r.response === "object" ? r.response : { result: r.response },
        },
      })),
    };
  }

  if (turn.role === "assistant") {
    // Google calls the assistant "model"; we call it "assistant" everywhere
    // else, and this is the only place that should ever need to know.
    const parts = [];
    if (turn.text) parts.push({ text: turn.text });
    for (const call of turn.calls || []) {
      const part = { functionCall: { name: call.name, args: call.args || {} } };
      // Thinking models reject a replayed functionCall that arrives without
      // the signature they issued with it: "Function call is missing a
      // thought_signature". It is opaque to us and only has to survive the
      // round trip intact, so it rides along on the turn and is put back here.
      if (call.signature) part.thoughtSignature = call.signature;
      parts.push(part);
    }
    return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
  }

  return { role: "user", parts: (turn.parts || []).map(toPart) };
}

function toPart(part) {
  if (part.type === "file") {
    // Under the inline threshold: the bytes travel with the request.
    return { inlineData: { mimeType: part.mime, data: part.data } };
  }
  if (part.type === "fileRef") {
    // Above it: an upload already sitting in Gemini's File API.
    return { fileData: { mimeType: part.mime, fileUri: part.uri } };
  }
  return { text: part.text || "" };
}

// Google returns a JSON error body; surface the human sentence out of it and
// fall back to the raw text if it isn't the shape we expect.
function extractApiMessage(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed && parsed.error && parsed.error.message;
    if (message) return String(message).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return String(body).slice(0, 300);
}
