/* Markdown → HTML. Hand-rolled because there is no build step here and a
   dependency would have to be vendored anyway; this covers what a chat reply
   actually contains and nothing else.

   Two rules it never breaks:
     · every scrap of model output is escaped before anything else happens,
       so a reply containing markup renders as text rather than executing;
     · an unterminated code fence still renders as a code block, because
       while a reply is streaming that is the normal state of the world. */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;
const FENCE = /^\s*```(.*)$/;

// A sentinel that cannot survive escapeHtml, so inline code can be lifted out,
// protected from the emphasis passes, and put back untouched.
const MARK = '\u0000';

function inline(src) {
  const held = [];
  let out = escapeHtml(src).replace(/`([^`]+)`/g, (_, code) => {
    held.push(code);
    return `${MARK}${held.length - 1}${MARK}`;
  });

  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // http(s) only — the scheme is the whole point of the check
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

  return out.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, i) => `<code>${held[i]}</code>`);
}

function codeBlock(lang, lines) {
  const label = lang ? escapeHtml(lang.trim().split(/\s+/)[0]) : 'text';
  return (
    `<div class="code">` +
    `<div class="code__bar"><span class="code__lang">${label}</span>` +
    `<button type="button" class="btn code__copy" data-copy>Copy</button></div>` +
    `<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>` +
    `</div>`
  );
}

export function markdown(src) {
  const lines = String(src == null ? '' : src).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence, if it ever arrives
      out.push(codeBlock(lang, body));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      out.push(`<blockquote>${inline(body.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(ordered ? NUMBER : BULLET);
        if (!m) break;
        items.push(`<li>${inline(ordered ? m[2] : m[1])}</li>`);
        i++;
      }
      const start = ordered ? Number(line.match(NUMBER)[1]) : 1;
      const attr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(ordered ? `<ol${attr}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // paragraph: run to the next blank line or block-level opener
    const para = [];
    while (i < lines.length && lines[i].trim() &&
           !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
           !RULE.test(lines[i]) && !QUOTE.test(lines[i]) &&
           !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('');
}
