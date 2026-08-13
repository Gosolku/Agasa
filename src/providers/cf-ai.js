// Cloudflare Workers AI, behind the provider interface in ./index.js.
//
// Everything OpenAI-shaped is contained in this file: the flat `messages`
// array, `tool_calls` with stringified arguments, the `tool` role, and the
// `data: {...}` / `[DONE]` stream envelope. Nothing outside it knows any of
// that, exactly as nothing outside gemini.js knows about `contents` and
// `functionCall`.
//
// There is no key: inference runs on the same network the Worker does, so the
// AI binding *is* the credential. That is the whole reason this provider
// exists — it lifts the ceiling off a design that was living inside twenty
// Gemini requests a day.
//
// Two things this model cannot do that Gemini can, both handled rather than
// hidden:
//   · attachments — it is text-only, so file parts are replaced with a note
//     saying so instead of being silently dropped
//   · thought signatures — a Gemini concept; `call.signature` is ignored here
//     and nothing asks for it back

import { toolFunctions } from "../tools/index.js";

// Llama 3.3 70B, the fp8 "fast" variant.
//
// Not the 8B model, which is cheaper and would have been the obvious pick:
// Workers AI's function-calling catalogue does not include any Llama 3.1
// model, and a provider that cannot call a tool is no use to an assistant
// whose entire design is twelve tools. The 70B fp8-fast model is the cheapest
// entry on that catalogue with published per-neuron rates.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// What the free allocation actually buys, per day.
//
// The allocation is 10,000 *Neurons* — a unit of GPU compute — not 10,000
// requests. For this model Cloudflare publishes 26,668 neurons per million
// input tokens and 204,805 per million output. A typical Agasa turn measured
// on the live site runs about 2,000 tokens in; allowing 300 out for a prose
// answer, that is roughly:
//
//     2000/1e6 × 26,668  +  300/1e6 × 204,805  ≈  115 neurons
//     10,000 ÷ 115                             ≈  87 requests
//
// Rounded down to 85 because the counter exists to warn early, and because a
// tool hop costs a whole extra request. This is an estimate of a compute
// budget expressed in requests, which is the only unit the status bar has —
// set DAILY_LIMIT explicitly if the real usage turns out to be shaped
// differently. Cloudflare also caps text generation at 300 requests/minute,
// which this counter does not model.
const DAILY_LIMIT = 85;

export const cfAi = {
  id: "cf-ai",
  label: "Workers AI",
  model: MODEL,
  dailyLimit: DAILY_LIMIT,

  // The binding is injected by the platform, so this is presence, not config.
  configured: (env) => Boolean(env && env.AI && typeof env.AI.run === "function"),

  async *stream({ messages, system, tools, env }) {
    const declared = functionsFrom(tools);
    const body = {
      // The default cap is 256 tokens, which truncates an ordinary answer
      // mid-sentence. This model's window is 24,000.
      max_tokens: 2048,
      messages: toMessages(system, messages),
    };
    if (declared.length) {
      // Cloudflare's native form is flat — { name, description, parameters } —
      // which is exactly what the manifest already holds. The nested OpenAI
      // envelope is also accepted, but wrapping something in a shape only to
      // have it unwrapped again is not worth the line.
      body.tools = declared.map((fn) => ({
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || { type: "object", properties: {} },
      }));
    }

    // Streaming and tools together are documented for the OpenAI-compatible
    // endpoint but not for this binding, and a half-supported combination
    // would fail as a turn that silently never calls anything. So: stream when
    // there is nothing to call, take the whole response when there is.
    //
    // In practice the tool layer always passes the manifest, so this provider
    // answers in one piece rather than token by token. That is a real loss
    // against Gemini and the honest trade for a ceiling this much higher; if
    // streamed tool calls are confirmed to work through the binding, this is
    // the one line that changes.
    const wantsStream = !body.tools;

    let result;
    try {
      // No signal: the binding has no documented abort, so a cancelled request
      // is dropped by the caller rather than stopped here. Passing an
      // undocumented option through to the platform is the worse guess.
      result = await env.AI.run(MODEL, { ...body, stream: wantsStream });
    } catch (err) {
      yield {
        type: "error",
        message: "Workers AI could not run the model.",
        detail: detailOf(err),
        // 429 is what the caller refunds a request against; Workers AI reports
        // an exhausted allowance as a capacity error rather than a status, so
        // it is mapped here rather than guessed at the call site.
        status: capacityError(err) ? 429 : undefined,
      };
      return;
    }

    if (wantsStream && result && typeof result.getReader === "function") {
      yield* readStream(result);
      return;
    }

    yield* readWhole(result);
  },
};

/* ── streaming: `data: {...}` frames, OpenAI-style ──────────────── */

async function* readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tokens = null;
  let reason = "stop";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Keep the trailing fragment — a frame can be split across reads.
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

        // Workers AI sends `{ response: "..." }`; the OpenAI-compatible shape
        // sends `{ choices: [{ delta: { content } }] }`. Accept either.
        const text =
          typeof chunk.response === "string"
            ? chunk.response
            : chunk.choices?.[0]?.delta?.content || "";
        if (text) yield { type: "delta", text };

        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish) reason = String(finish).toLowerCase();

        const usage = chunk.usage;
        if (usage) {
          tokens = {
            in: usage.prompt_tokens || 0,
            out: usage.completion_tokens || 0,
          };
        }
      }
    }
  } catch (err) {
    yield {
      type: "error",
      message: "The connection to Workers AI dropped mid-answer.",
      detail: detailOf(err),
    };
    return;
  }

  if (tokens) yield { type: "usage", tokens };
  yield { type: "done", reason };
}

/* ── whole response: the path a tool turn takes ────────────────── */

async function* readWhole(result) {
  if (!result || typeof result !== "object") {
    yield { type: "error", message: "Workers AI returned nothing usable." };
    return;
  }

  const choice = result.choices?.[0];
  const message = choice?.message;

  const text =
    (typeof result.response === "string" ? result.response : "") ||
    message?.content ||
    "";
  if (text) yield { type: "delta", text };

  const calls = collectCalls(result, message);

  const usage = result.usage;
  if (usage) {
    yield {
      type: "usage",
      tokens: { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0 },
    };
  }

  if (calls.length) yield { type: "tool_call", calls };
  yield {
    type: "done",
    reason: calls.length
      ? "tool_call"
      : String(choice?.finish_reason || "stop").toLowerCase(),
  };
}

/**
 * Workers AI has shipped tool calls in more than one shape. Both are read
 * here so an upstream change of envelope is a non-event:
 *   · `{ tool_calls: [{ name, arguments }] }`            — the native shape
 *   · `{ choices: [{ message: { tool_calls: [...] } }] }` — OpenAI-compatible
 * Arguments arrive as an object in the first and a JSON string in the second.
 */
function collectCalls(result, message) {
  const raw = [
    ...(Array.isArray(result.tool_calls) ? result.tool_calls : []),
    ...(Array.isArray(message?.tool_calls) ? message.tool_calls : []),
  ];

  return raw
    .map((call) => {
      const fn = call.function || call;
      const name = String(fn.name || "");
      if (!name) return null;
      return { name, args: parseArgs(fn.arguments ?? fn.args), signature: null };
    })
    .filter(Boolean);
}

function parseArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A model that emits malformed JSON has effectively called the tool with
    // nothing; the registry will reject it on its arguments rather than here.
    return {};
  }
}

/* ── turn → OpenAI-style message ───────────────────────────────── */

function toMessages(system, turns) {
  const out = [{ role: "system", content: system }];

  for (const turn of turns) {
    if (turn.role === "assistant") {
      const message = { role: "assistant", content: turn.text || "" };
      const calls = turn.calls || [];
      if (calls.length) {
        message.tool_calls = calls.map((call, i) => ({
          id: `call_${i}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          },
        }));
      }
      out.push(message);
      continue;
    }

    if (turn.role === "tool") {
      // One message per result, in the order the calls were made — the same
      // ordering rule Gemini has, for the same reason.
      turn.responses.forEach((response, i) => {
        out.push({
          role: "tool",
          tool_call_id: `call_${i}`,
          name: response.name,
          content: JSON.stringify(response.response ?? {}),
        });
      });
      continue;
    }

    out.push({ role: "user", content: textOf(turn) });
  }

  return out;
}

/** Flatten a user turn's parts. Attachments are named rather than dropped, so
 *  the model can say it cannot read them instead of ignoring the question. */
function textOf(turn) {
  return (turn.parts || [])
    .map((part) => {
      if (part.type === "file" || part.type === "fileRef") {
        return `[attachment: ${part.mime} — this model cannot read attachments]`;
      }
      return part.text || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/* ── plumbing ──────────────────────────────────────────────────── */

/** Prefer whatever the caller passed, unwrapping Google's envelope if that is
 *  what arrived; otherwise take the manifest's list directly. */
function functionsFrom(tools) {
  if (Array.isArray(tools) && tools.length) {
    if (tools[0] && Array.isArray(tools[0].functionDeclarations)) {
      return tools[0].functionDeclarations;
    }
    return tools;
  }
  return toolFunctions();
}

const detailOf = (err) =>
  String(err && err.message ? err.message : err).slice(0, 300);

const capacityError = (err) =>
  /capacity|rate limit|quota|too many requests|429/i.test(detailOf(err));
