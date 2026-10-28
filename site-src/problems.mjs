// The apü problem types (src/protocol.ts `ProblemType`), one page each at
// https://apue.dev/problems/<name>. Every statement here is taken from the code (src/), the tests
// (test/) or SPEC-DRAFT.md; the example documents are what the reference implementation sends, with
// the member order it produces. check.mjs fails if a type in src/ has no entry or no page.
//
// Fields: name, title (the problem's `title`), statuses [[code, where]], summary (one sentence),
// when (HTML), members [[name, HTML]], examples [{ caption, lang, code }], react (HTML list items),
// source (where it is raised), related [[site path, label]].

const T = (name) => `https://apue.dev/problems/${name}`;
const json = (value) => JSON.stringify(value, null, 2);
const response = (status, problem, extra = '') =>
  `HTTP/2 ${status}\ncontent-type: application/problem+json\ncache-control: no-store${extra}\n\n${json(problem)}`;
const end = (problem) => json({ status: problem.status, problem });

const RETRYABLE = ['retryable', '<code>true</code> — repeating the same request later may succeed.'];

export const PROBLEMS = [
  {
    name: 'validation-failed',
    title: 'Validation Failed',
    statuses: [['400', 'response, or in an END frame']],
    summary: 'The input does not match the operation’s input schema.',
    when: `<p>Every input is validated against the operation’s schema before the handler runs: a JSON body, the canonical <code>?i=</code> input of a <code>GET</code>, every message of a request stream (<code>input message 3 does not match the schema</code>), and every call of a pipelined batch after its references are resolved. The handler never sees invalid input.</p>
<p>The same type is used when an upload reference (<code>{"$upload": id}</code>, where the schema has <code>t.bytes()</code> or <code>t.file()</code>) is unknown, incomplete or expired for this caller; <code>fields</code> then names the path of the reference.</p>
<p>The TypeScript client validates input before sending and throws this problem itself — invalid input never leaves the client.</p>`,
    members: [
      ['fields', 'One entry per problem found: <code>[{ "path": "title", "message": "shorter than 1" }]</code>. <code>path</code> locates the value in the input.'],
    ],
    examples: [
      {
        caption: 'POST /todos.create with {"title":""} (docs/wire.md)',
        lang: 'http',
        code: response(400, { type: T('validation-failed'), fields: [{ path: 'title', message: 'shorter than 1' }], title: 'Validation Failed', status: 400, detail: 'input does not match the schema' }),
      },
    ],
    react: [
      'Don’t retry unchanged: the same input fails the same way.',
      'Show each entry of <code>fields</code> next to the input it names; <code>detail</code> says which input (the call’s input or a numbered request-stream message).',
      'For an upload reference: upload the content again and repeat the call with the new reference.',
    ],
    source: 'src/server.ts (input and upload references), src/client.ts (client-side validation)',
    related: [['docs/concepts.html', 'Operations & HTTP mapping'], ['docs/binary-data.html', 'Binary data']],
  },
  {
    name: 'unknown-operation',
    title: 'Unknown Operation',
    statuses: [['404', 'response']],
    summary: 'No operation with that name exists on this server.',
    when: `<p>The request path names no operation of the API — and, if the server has a <code>fallback</code> (for example the web app served from the same origin), the fallback didn’t handle it either. <code>detail</code> is the operation name as requested.</p>
<p>Clients raise the same problem without sending anything when asked to call an operation their API definition doesn’t contain. Inside a pipelined batch an unknown operation is a structural error instead: <a href="/problems/invalid-batch">invalid-batch</a>.</p>`,
    members: [],
    examples: [
      {
        caption: 'curl -i https://localhost:18443/nope.nothing (docs/wire.md)',
        lang: 'http',
        code: response(404, { type: T('unknown-operation'), title: 'Unknown Operation', status: 404, detail: 'nope.nothing' }),
      },
    ],
    react: [
      'Don’t retry: client and server disagree about the API.',
      'Check the base URL, then compare with the server’s manifest at <code>/.well-known/apue</code> — and regenerate a generated client from it (<code>apue-types</code>).',
    ],
    source: 'src/server.ts, src/client.ts, src/batch.ts',
    related: [['docs/manifest.html', 'Manifest & codegen']],
  },
  {
    name: 'invalid-selection',
    title: 'Invalid Selection',
    statuses: [['400', 'response, before the handler runs']],
    summary: 'A field selection (?s=) names a path the output schema doesn’t have.',
    when: `<p>Field selection (<code>?s=a,b.c</code>) is validated against the operation’s output schema before the handler runs: every path must exist in the schema (through objects, arrays, optional and nullable fields), the selection must not be empty, and it may have at most 64 paths. <code>detail</code> says what is wrong, e.g. <code>unknown field secret</code>.</p>
<p>In a pipelined batch, an invalid <code>select</code> makes the whole batch an <a href="/problems/invalid-batch">invalid-batch</a>.</p>`,
    members: [],
    examples: [
      {
        caption: 'GET /users.get?i=…&s=secret (test/select.test.ts)',
        lang: 'http',
        code: response(400, { type: T('invalid-selection'), title: 'Invalid Selection', status: 400, detail: 'unknown field secret' }),
      },
    ],
    react: [
      'Don’t retry unchanged; fix the selection.',
      'With the TypeScript client, <code>pick(op, input, paths)</code> checks the paths at compile time.',
    ],
    source: 'src/select.ts, src/server.ts',
    related: [['docs/concepts.html', 'Operations & HTTP mapping']],
  },
  {
    name: 'malformed-stream',
    title: 'Malformed Stream',
    statuses: [['400', 'server: a request stream'], ['502', 'client: a response stream']],
    summary: 'A framed body contains frames that can’t be decoded.',
    when: `<p>Streams are sequences of frames with an 8-byte header. The server answers <code>400</code> when a request stream contains something it can’t decode: a message that isn’t valid JSON, a frame on a lane other than 0, a BLOB frame for an operation without bytes, an END frame without a status — over HTTP and over the WebSocket tier alike. Frame headers announcing more than the size limit are rejected before buffering (that one is a <code>413</code>).</p>
<p>A client that can’t decode a response stream raises the same type with status <code>502</code>: the body it got isn’t what an apü server sends.</p>`,
    members: [],
    examples: [
      {
        caption: 'a request stream with a frame on lane 1 (src/server.ts)',
        lang: 'json',
        code: json({ type: T('malformed-stream'), title: 'Malformed Stream', status: 400, detail: 'lane 1 in a request stream' }),
      },
    ],
    react: [
      'Don’t retry: a peer or something in between produced invalid frames. A malformed response stream is never resumed.',
      'Look for a proxy that rewrites bodies, or an encoder bug on the sending side.',
    ],
    source: 'src/server.ts, src/websocket.ts, src/client.ts',
    related: [['docs/wire-format.html', 'Wire format'], ['docs/streaming.html', 'Streaming']],
  },
  {
    name: 'truncated-stream',
    title: 'Truncated Stream',
    statuses: [['400', 'server: a request stream'], ['502', 'client: a response stream or batch lane']],
    summary: 'A framed body ended before its END frame.',
    when: `<p>Every lane of a framed body ends with an END frame that carries its final status. A body that stops without one was cut off — typically by a proxy or load balancer timing out, or a connection lost. The server answers <code>400</code> for a request stream that ends early; a client raises <code>502</code> for a response stream (<code>response ended without END frame</code>) and for each batch lane left open (<code>lanes 1, 2 ended without END frame</code>).</p>`,
    members: [],
    examples: [
      {
        caption: 'raised by the client for a response stream (src/client.ts)',
        lang: 'json',
        code: json({ type: T('truncated-stream'), title: 'Truncated Stream', status: 502, detail: 'response ended without END frame' }),
      },
    ],
    react: [
      'A resumable stream that already received a checkpoint is resumed instead: the client re-sends the call with the token (<code>apue-resume</code>) and continues exactly once, within its <code>resumes</code> budget (default 3).',
      'Otherwise the items received so far are valid, but the stream is incomplete: treat the call as failed.',
      'If it happens repeatedly, check intermediary timeouts; servers send a HEARTBEAT frame after 15 s without other frames to keep idle streams alive.',
    ],
    source: 'src/server.ts, src/client.ts, src/batch.ts',
    related: [['docs/streaming.html', 'Streaming'], ['docs/caching.html', 'Caching, CDNs & proxies']],
  },
  {
    name: 'deadline-exceeded',
    title: 'Deadline Exceeded',
    statuses: [['504', 'response, or in an END frame']],
    summary: 'The call’s deadline (apue-timeout) passed before it completed.',
    when: `<p>A client can give a call a deadline in milliseconds with the <code>apue-timeout</code> header (WebSocket: <code>?timeout=</code>; the TypeScript client’s <code>timeoutMs</code> option). When it passes, the server aborts the handler’s <code>ctx.signal</code> and answers <code>504</code> — also when a stream’s producer ignores the signal. A stream whose headers are already sent ends with this problem in its END frame. For a pipelined batch the deadline covers the whole batch.</p>`,
    members: [],
    examples: [
      {
        caption: 'unary call over its deadline (src/server.ts)',
        lang: 'http',
        code: response(504, { type: T('deadline-exceeded'), title: 'Deadline Exceeded', status: 504 }),
      },
    ],
    react: [
      'The reference clients don’t retry a 504 on their own: the deadline is the caller’s budget. Decide in the application whether to try again with a new deadline.',
      'For a non-safe call, a 5xx releases its <code>Idempotency-Key</code>: repeating it with the same key executes it again.',
    ],
    source: 'src/server.ts',
    related: [['docs/concepts.html', 'Operations & HTTP mapping'], ['docs/client.html', 'Client reference']],
  },
  {
    name: 'download-expired',
    title: 'Download Expired',
    statuses: [['410', 'response']],
    summary: 'An Idempotency-Key replay whose stored result refers to a download that has expired.',
    when: `<p>Outputs typed <code>t.download()</code> carry a short-lived download URL (<code>/$downloads/&lt;id&gt;</code>, 15 minutes by default). When a non-safe call is repeated with the same <code>Idempotency-Key</code>, the server replays the stored result and refreshes the expiry of its download URLs. If one of them has already expired, the stored result can’t be served with a working link: the server answers <code>410</code> with this problem instead — it never hands out a dead link and never runs the operation a second time.</p>`,
    members: [],
    examples: [
      {
        caption: 'replay after the download expired (src/server.ts)',
        lang: 'http',
        code: response(410, { type: T('download-expired'), title: 'Download Expired', status: 410, detail: 'the stored result of this Idempotency-Key refers to a download that has expired; the operation was not run again' }),
      },
    ],
    react: [
      'The operation already ran: don’t repeat it with a new key unless running it again is what you want.',
      'Fetch the result another way the API offers (e.g. a read operation), or ask for a new download through it.',
    ],
    source: 'src/server.ts, src/downloads.ts',
    related: [['docs/binary-data.html', 'Binary data'], ['docs/concepts.html', 'Operations & HTTP mapping']],
  },
  {
    name: 'idempotency-key-in-progress',
    title: 'Idempotency Key In Progress',
    statuses: [['409', 'response']],
    summary: 'A request with the same Idempotency-Key is still being processed.',
    when: `<p>Non-safe unary calls carry an <code>Idempotency-Key</code>; its scope is the operation, the caller and the key. When a second request arrives in that scope while the first is still running — a client retried before the original answered — the second gets this <code>409</code> instead of executing the call twice.</p>`,
    members: [RETRYABLE],
    examples: [
      {
        caption: 'a retry that overtook the original (src/server.ts)',
        lang: 'http',
        code: response(409, { type: T('idempotency-key-in-progress'), retryable: true, title: 'Idempotency Key In Progress', status: 409, detail: 'a request with this Idempotency-Key is still being processed' }),
      },
    ],
    react: [
      'Wait and repeat the request with the same key and the same payload. Once the original has finished, the stored response is replayed (<code>apue-replayed: ?1</code>).',
      'The TypeScript client does this by itself: a <code>409</code> with <code>retryable: true</code> is retried with backoff. Any other <code>409</code> is not.',
    ],
    source: 'src/server.ts, src/idempotency.ts',
    related: [['docs/concepts.html#idempotency-keys', 'Idempotency keys']],
  },
  {
    name: 'idempotency-key-reused',
    title: 'Idempotency Key Reused',
    statuses: [['422', 'response']],
    summary: 'The Idempotency-Key was already used with a different payload.',
    when: `<p>The server remembers each key with a fingerprint of its input (SHA-256 of the canonical JSON). A request with a known key but a different input is refused, because replaying the stored response would answer a different request.</p>`,
    members: [],
    examples: [
      {
        caption: 'same key, different payload (src/server.ts)',
        lang: 'http',
        code: response(422, { type: T('idempotency-key-reused'), title: 'Idempotency Key Reused', status: 422, detail: 'Idempotency-Key was already used with a different request payload' }),
      },
    ],
    react: [
      'Don’t retry: this is a bug in how keys are chosen. Use a fresh key for every new logical request and the same key only for repeats of it.',
      'The TypeScript client generates a key per call unless you pass one (<code>idempotencyKey</code>).',
    ],
    source: 'src/server.ts, src/idempotency.ts',
    related: [['docs/concepts.html#idempotency-keys', 'Idempotency keys']],
  },
  {
    name: 'invalid-batch',
    title: 'Invalid Batch',
    statuses: [['400', 'response, before any call runs']],
    summary: 'A pipelined batch failed structural validation; nothing was executed.',
    when: `<p>A batch is checked as a whole before any call starts, and rejected all or nothing: the body must be <code>{"calls": [...]}</code> with 1 to 64 calls (server-configurable); every call must name a known operation without a request stream, have a valid <code>key</code> and a valid <code>select</code>; references (<code>$ref</code>) must be well-formed and point to <em>earlier</em>, non-streaming calls. <code>detail</code> names the call and the reason.</p>`,
    members: [],
    examples: [
      {
        caption: 'POST /$batch whose second call names no operation (src/server.ts)',
        lang: 'http',
        code: response(400, { type: T('invalid-batch'), title: 'Invalid Batch', status: 400, detail: 'call 1: unknown operation nope.nothing' }),
      },
    ],
    react: [
      'Don’t retry unchanged: fix how the batch is built.',
      'The TypeScript batch builder only lets later calls reference earlier ones, typed along the output (<code>ref()</code>).',
    ],
    source: 'src/server.ts, src/refs.ts',
    related: [['docs/batches.html', 'Pipelined batches']],
  },
  {
    name: 'unresolvable-reference',
    title: 'Unresolvable Reference',
    statuses: [['400', 'in the lane’s END frame']],
    summary: 'A $ref points to a path that the referenced call’s output doesn’t contain.',
    when: `<p>References are resolved when a call’s dependencies have finished. If the referenced output has no value at the path — an optional field that is absent, say — the call ends with this problem on its own lane. Calls that depend on it then end with <a href="/problems/failed-dependency">failed-dependency</a>; independent calls are not affected.</p>`,
    members: [],
    examples: [
      {
        caption: 'END frame of a lane that referenced boss.manager.id (test/batch.test.ts)',
        lang: 'json',
        code: end({ type: T('unresolvable-reference'), title: 'Unresolvable Reference', status: 400, detail: 'call 0 output has no manager' }),
      },
    ],
    react: [
      'Handle it per call: only that call’s result (and its dependents’) fails.',
      'Reference only fields the output always has, or split the dependent call out of the batch where the field is optional.',
    ],
    source: 'src/server.ts, src/refs.ts',
    related: [['docs/batches.html', 'Pipelined batches']],
  },
  {
    name: 'failed-dependency',
    title: 'Failed Dependency',
    statuses: [['424', 'in the lane’s END frame']],
    summary: 'A batch call was not executed because a call it references failed.',
    when: `<p>In a pipelined batch, a call runs once the calls it references have succeeded. If one of them failed, the call is not executed and its lane ends with <code>424</code>, transitively: calls that depend on it fail the same way. <code>detail</code> names the failed calls.</p>`,
    members: [],
    examples: [
      {
        caption: 'END frame of a call that referenced the failed call 0 (src/server.ts)',
        lang: 'json',
        code: end({ type: T('failed-dependency'), title: 'Failed Dependency', status: 424, detail: 'depends on failed call 0' }),
      },
    ],
    react: [
      'Look at the referenced call’s own error: it is the cause.',
      'Resending the whole batch is safe — calls with a <code>key</code> are replayed, not executed again.',
    ],
    source: 'src/server.ts',
    related: [['docs/batches.html', 'Pipelined batches'], ['docs/errors.html#errors-in-batches', 'Errors in batches']],
  },
  {
    name: 'invalid-resume-token',
    title: 'Invalid Resume Token',
    statuses: [['400', 'response, before the stream starts']],
    summary: 'A resume token is malformed, forged, expired or for another call.',
    when: `<p>Resumable streams send signed CHECKPOINT tokens; after a lost connection the client re-sends the call with <code>apue-resume: &lt;token&gt;</code> (SSE: <code>Last-Event-ID</code>). The server refuses a token that is malformed, signed with another secret, expired (15 minutes by default), or issued for another operation or input — and, with a <code>principal</code> hook, for another caller. <code>detail</code> says which.</p>`,
    members: [],
    examples: [
      {
        caption: 'a token past its lifetime (src/resume.ts)',
        lang: 'http',
        code: response(400, { type: T('invalid-resume-token'), title: 'Invalid Resume Token', status: 400, detail: 'token expired' }),
      },
    ],
    react: [
      'Don’t resend the token: it won’t become valid. Start the stream again without it, from the beginning or from an application-level cursor in the input.',
      'Behind several replicas, every replica needs the same <code>resume.secret</code>.',
    ],
    source: 'src/resume.ts',
    related: [['docs/streaming.html#resumable-streams', 'Resumable streams']],
  },
];
