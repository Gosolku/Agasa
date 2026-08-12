// The wire format between the Worker and the browser.
//
// The point of this file is that it is *ours*. Previously the Worker piped
// Google's SSE frames straight through and the browser reached into
// `candidates[0].content.parts` to find the text — which meant swapping
// provider would have meant rewriting the front end. Everything now gets
// normalised here, so the client only ever learns this vocabulary.

/**
 * @typedef {"meta"|"delta"|"tool_call"|"action"|"usage"|"done"|"error"} WireEvent
 *
 * meta      — sent once, first: which provider/model answered, current quota.
 * delta     — a chunk of assistant text. Many of these.
 * tool_call — the model wants the browser to do something. Carries a resume
 *             token and one or more calls. Terminal for this request: the
 *             turn continues on /api/tool-result, not on this stream.
 * action    — a call that needs confirmation before it runs. Rendered as an
 *             Allow/Deny prompt; the decision feeds back into the same
 *             /api/tool-result round trip.
 * usage     — token counts, once known (providers report these late).
 * done      — the turn finished cleanly. Carries the finish reason; `reason`
 *             is "tool_call" when the stream stopped to hand over to the
 *             browser rather than because the model had finished talking.
 * error     — the turn failed. Terminal; no further events follow.
 */

export function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Drain a provider's normalised event stream into an SSE ReadableStream.
 *
 * Provider events and wire events deliberately share names — the mapping is
 * currently one-to-one — but they are separate vocabularies. A provider that
 * needed re-shaping (batching deltas, splitting a tool call into an `action`)
 * would do it here rather than leaking its own shape to the browser.
 *
 * @param {AsyncIterable<object>} events
 * @param {object} head  the `meta` frame, sent before the provider is touched
 */
export function toSSE(events, head) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      // If the reader has gone away mid-turn (tab closed, navigation, abort)
      // the controller is already closed and enqueuing throws. That is a
      // normal way for a stream to end, not an error worth propagating.
      let gone = false;
      const push = (event, data) => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(frame(event, data)));
        } catch {
          gone = true;
        }
      };

      // Send meta immediately so the status line can show the model and
      // switch to "streaming" while the provider is still connecting.
      push("meta", head);

      let closed = false;
      try {
        for await (const event of events) {
          const { type, ...rest } = event;
          push(type, rest);
          // error and done are terminal by contract — a provider that keeps
          // yielding after one is misbehaving, and we stop listening.
          if (type === "error" || type === "done") {
            closed = true;
            break;
          }
        }
        if (!closed) push("done", { reason: "stop" });
      } catch (err) {
        // A throw mid-stream means the response is already half-written, so
        // the only honest thing left is to tell the client it ended badly.
        push("error", {
          message: "The response stopped unexpectedly.",
          detail: String(err && err.message ? err.message : err).slice(0, 300),
        });
      } finally {
        controller.close();
      }
    },
  });
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};
