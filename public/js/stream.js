/* Client half of the wire protocol in src/protocol.js.

   This is the only file that knows the transport is SSE. It speaks our own
   event names — meta / delta / tool_call / action / usage / done / error —
   and has never heard of Gemini. Swapping the provider changes nothing here.

   One user message can span several HTTP requests: the model asks for a tool,
   the Worker parks the turn and hands back a token, the browser does the work
   and posts the result to resume it. That loop lives here rather than in
   main.js, so from the caller's side a turn is still one call that ends in
   exactly one `done` or one `error`. */

const MAX_HANDOVERS = 5; // matches MAX_HOPS in worker.js

/**
 * @param {object} opts
 * @param {Array<object>} opts.messages   full turn list
 * @param {object} [opts.client]          interface state, for context
 * @param {AbortSignal} [opts.signal]
 * @param {Record<string, Function>} opts.on  handlers by event name
 * @param {(calls:Array<object>) => Promise<Array<object>>} [opts.onToolCall]
 *        executes the calls and resolves to [{ id, response }]
 */
export async function streamChat({ messages, client, signal, on = {}, onToolCall }) {
  const emit = (name, data) => {
    if (typeof on[name] === 'function') on[name](data);
  };

  let response;
  try {
    response = await post('/api/chat', { messages, client }, signal);
  } catch (err) {
    return fail(emit, err);
  }

  for (let handovers = 0; ; handovers++) {
    if (!response.ok || !response.body) {
      return emit('error', {
        message: `The server answered ${response.status} instead of a stream.`,
      });
    }

    let handover;
    try {
      handover = await consume(response, emit, signal);
    } catch (err) {
      return fail(emit, err);
    }

    // No handover means the turn ended on its own — `done` or `error` has
    // already gone out from consume(), and there is nothing left to do.
    if (!handover) return;

    if (handovers >= MAX_HANDOVERS || typeof onToolCall !== 'function') {
      return emit('error', {
        message: 'The assistant asked for more tool calls than one turn allows.',
      });
    }

    let results;
    try {
      results = await onToolCall(handover.calls);
    } catch (err) {
      // An executor that blew up still has to be reported, or the parked turn
      // sits on the server until it expires and the user sees nothing at all.
      results = handover.calls.map((call) => ({
        id: call.id,
        response: { ok: false, error: String((err && err.message) || err).slice(0, 200) },
      }));
    }

    try {
      response = await post('/api/tool-result', { token: handover.token, results, client }, signal);
    } catch (err) {
      return fail(emit, err);
    }
  }
}

function post(url, body, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function fail(emit, err) {
  if (err && err.name === 'AbortError') return emit('aborted', {});
  return emit('error', {
    message: 'The request never left the building — you may be offline.',
  });
}

/**
 * Read one SSE response to its end.
 * @returns {Promise<{token:string, calls:Array}|null>} a handover, if the
 *          stream stopped to hand tool calls to the browser.
 */
async function consume(response, emit, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];
  let handover = null;

  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    const name = event;
    data = [];
    event = 'message';

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // a frame we can't read is not worth ending the turn over
    }

    if (name === 'tool_call') {
      handover = { token: parsed.token, calls: parsed.calls || [] };
      emit('tool_call', parsed);
      return;
    }
    // A `done` that only marks the handover point is swallowed: the caller is
    // promised one terminal event per turn, and this isn't it.
    if (name === 'done' && parsed.reason === 'tool_call') return;

    emit(name, parsed);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep the partial line for the next read

      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line) { dispatch(); continue; }      // blank line ends a frame
        if (line.startsWith(':')) continue;        // comment / keep-alive
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    dispatch(); // a stream that ends without a trailing blank line still counts
  } catch (err) {
    if (err && err.name === 'AbortError') { emit('aborted', {}); return null; }
    emit('error', { message: 'The connection dropped part-way through.' });
    return null;
  }

  if (signal && signal.aborted) return null;
  return handover;
}
