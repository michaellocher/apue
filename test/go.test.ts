// Go clients generated from the manifest (`apue-types --lang go`): a real Go program calls a real
// server — unary, streams (full duplex bidi), errors, idempotency, retries, deadlines,
// cancellation, bytes, uploads, downloads (resumed and verified), and the generated file is vetted
// and gofmt-clean.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { canonicalJson, defineApi, op } from '../src/api.ts';
import { generateGo, goName } from '../src/codegen-go.ts';
import type { Manifest } from '../src/codegen.ts';
import { download } from '../src/downloads.ts';
import { ApueError } from '../src/protocol.ts';
import { t } from '../src/schema.ts';
import type { Handlers } from '../src/server.ts';
import { sleep, startServer, testCert } from './helpers.ts';

const go = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
    return { go: 'go', gofmt: join(goroot, 'bin', 'gofmt') };
  } catch {
    return undefined;
  }
})();
// Standard library only: no module downloads, no toolchain switch.
const GO_ENV = { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off', GOTOOLCHAIN: 'local', GOWORK: 'off', CGO_ENABLED: '0' };

const Profile = t.object({
  name: t.string(),
  age: t.optional(t.number({ int: true })),
  score: t.number(),
  address: t.optional(t.object({ city: t.string(), zip: t.nullable(t.string()) })),
  labels: t.array(t.enum(['x', 'y'])),
  manager: t.nullable(t.object({ id: t.string() })),
  extra: t.unknown(),
  active: t.boolean(),
  empty: t.optional(t.array(t.string())),
  nothing: t.optional(t.array(t.string())),
});

const api = defineApi({
  'users.get': op({ effect: 'safe', input: t.object({ id: t.string({ min: 2 }) }), output: t.object({ id: t.string(), role: t.enum(['admin', 'member']), tags: t.optional(t.array(t.string())), method: t.string(), http: t.string() }) }),
  'users.none': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'text.length': op({ effect: 'safe', input: t.object({ text: t.string() }), output: t.object({ length: t.number(), method: t.string(), text: t.string() }) }),
  'search.get': op({ effect: 'safe', input: t.object({ q: t.string(), limit: t.number(), filter: t.object({ b: t.boolean(), a: t.number() }), nums: t.array(t.number()) }), output: t.string() }),
  'profile.put': op({ effect: 'idempotent', input: Profile, output: t.object({ profile: Profile, keys: t.array(t.string()) }) }),
  'keys.echo': op({ effect: 'unsafe', input: t.void(), output: t.string() }),
  'orders.create': op({ effect: 'unsafe', input: t.object({ item: t.string() }), output: t.number() }),
  'orders.fail': op({ effect: 'unsafe', input: t.void(), output: t.void() }),
  'orders.flaky': op({ effect: 'unsafe', input: t.void(), output: t.object({ attempts: t.number(), keys: t.array(t.string()) }) }),
  'flaky.get': op({ effect: 'safe', input: t.void(), output: t.number() }),
  'count.up': op({ effect: 'safe', stream: 'server', input: t.object({ to: t.number() }), output: t.number() }),
  'count.fail': op({ effect: 'safe', stream: 'server', input: t.void(), output: t.number() }),
  'sum.client': op({ effect: 'unsafe', stream: 'client', input: t.number(), output: t.number() }),
  'echo.bidi': op({ effect: 'unsafe', stream: 'bidi', input: t.object({ n: t.number() }), output: t.object({ n: t.number(), http: t.string() }) }),
  'blobs.bidi': op({ effect: 'unsafe', stream: 'bidi', input: t.object({ data: t.bytes(), extra: t.unknown() }), output: t.object({ data: t.bytes(), extra: t.unknown(), size: t.number() }) }),
  'files.echo': op({ effect: 'unsafe', input: t.object({ data: t.bytes(), extra: t.unknown() }), output: t.object({ data: t.bytes(), size: t.number(), extra: t.unknown() }) }),
  'files.ingest': op({ effect: 'unsafe', input: t.object({ file: t.file(), cover: t.optional(t.file()) }), output: t.object({ size: t.number(), sha256: t.string(), cover: t.optional(t.number()) }) }),
  'export.get': op({ effect: 'safe', input: t.void(), output: t.object({ archive: t.download(), note: t.optional(t.download()) }) }),
  'slow.get': op({ effect: 'safe', input: t.void(), output: t.string() }),
  'type': op({ effect: 'safe', input: t.void(), output: t.object({ 'odd-key': t.nullable(t.number()) }) }),
  'close': op({ effect: 'unsafe', input: t.void(), output: t.string() }),
});

const EXPORT = new Uint8Array(3 * 1024 * 1024 + 3).map((_, i) => (i * 7) % 251);
let orders = 0;
let flakyGets = 0;
const flakyOrders = { attempts: 0, keys: [] as string[] };
const unavailable = () => new ApueError(503, 'Service Unavailable', 'try again', { retryable: true }, { 'retry-after': '0' });
const handlers: Handlers<typeof api> = {
  'users.get': ({ id }, ctx) => ({ id, role: 'member', tags: ['a'], method: ctx.method, http: ctx.httpVersion }),
  'users.none': () => 'none',
  'text.length': ({ text }, ctx) => ({ length: [...text].length, method: ctx.method, text }),
  'search.get': ({ q }) => q,
  'profile.put': (profile) => ({ profile, keys: Object.keys(profile) }),
  'keys.echo': (_, ctx) => String(ctx.headers['idempotency-key']),
  'orders.create': () => ++orders,
  'orders.fail': () => {
    throw new ApueError(409, 'Out Of Stock', 'item gone', { type: 'https://example.com/problems/out-of-stock' });
  },
  'orders.flaky': (_, ctx) => {
    flakyOrders.keys.push(String(ctx.headers['idempotency-key']));
    if (++flakyOrders.attempts === 1) throw unavailable(); // 5xx releases the key: the retry runs again
    return flakyOrders;
  },
  'flaky.get': () => {
    if (++flakyGets % 3 !== 0) throw unavailable();
    return flakyGets;
  },
  'count.up': async function* ({ to }) {
    for (let i = 1; i <= to; i++) yield i;
  },
  'count.fail': async function* () {
    yield 1;
    await sleep(20); // after the headers: the error can only travel in the END frame
    throw new ApueError(409, 'Conflict', 'midway');
  },
  'sum.client': async (inputs) => {
    let sum = 0;
    for await (const n of inputs) sum += n;
    return sum;
  },
  'echo.bidi': async function* (inputs, ctx) {
    for await (const { n } of inputs) yield { n: n * 2, http: ctx.httpVersion };
  },
  'blobs.bidi': async function* (inputs) {
    for await (const { data, extra } of inputs) yield { data, extra, size: data.byteLength };
  },
  'files.echo': ({ data, extra }) => ({ data, size: data.byteLength, extra }),
  'files.ingest': async ({ file, cover }) => {
    const hash = createHash('sha256');
    for await (const chunk of file.stream()) hash.update(chunk);
    return { size: file.size, sha256: hash.digest('hex'), ...(cover ? { cover: cover.size } : {}) };
  },
  'export.get': () => ({ archive: download.fromBytes(EXPORT, { type: 'application/x-test' }) }),
  'slow.get': async () => {
    await sleep(500);
    return 'late';
  },
  'type': () => ({ 'odd-key': null }),
  'close': () => 'closed',
};

const MAIN = String.raw`package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"apuetest/api"
)

type entry struct {
	Method  string
	Path    string
	Query   string
	Range   string
	IfRange string
}

// recorder logs requests and can fail requests, end a response early (like a proxy cutting it
// off) or cut or corrupt a download response.
type recorder struct {
	next     http.RoundTripper
	mu       sync.Mutex
	log      []entry
	failNext atomic.Int32
	eofAfter atomic.Int64
	cut      atomic.Int64
	corrupt  atomic.Bool
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.log = append(r.log, entry{req.Method, req.URL.Path, req.URL.RawQuery, req.Header.Get("Range"), req.Header.Get("If-Range")})
	r.mu.Unlock()
	if r.failNext.Load() > 0 {
		r.failNext.Add(-1)
		if req.Body != nil {
			req.Body.Close()
		}
		return nil, errors.New("injected: connection lost")
	}
	resp, err := r.next.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	if n := r.eofAfter.Swap(0); n > 0 {
		resp.Body = &eofBody{resp.Body, n}
	}
	if !strings.HasPrefix(req.URL.Path, "/$downloads/") {
		return resp, err
	}
	if n := r.cut.Swap(0); n > 0 {
		resp.Body = &cutBody{resp.Body, n}
	}
	if r.corrupt.Swap(false) {
		resp.Body = &corruptBody{rc: resp.Body}
	}
	return resp, nil
}

func (r *recorder) entries() []entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]entry(nil), r.log...)
}

type cutBody struct {
	rc   io.ReadCloser
	left int64
}

func (b *cutBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		return 0, errors.New("injected: connection lost")
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.rc.Read(p)
	b.left -= int64(n)
	return n, err
}

func (b *cutBody) Close() error { return b.rc.Close() }

type eofBody struct {
	rc   io.ReadCloser
	left int64
}

func (b *eofBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.rc.Read(p)
	b.left -= int64(n)
	return n, err
}

func (b *eofBody) Close() error { return b.rc.Close() }

type corruptBody struct {
	rc   io.ReadCloser
	done bool
}

func (b *corruptBody) Read(p []byte) (int, error) {
	n, err := b.rc.Read(p)
	if n > 0 && !b.done {
		p[0] ^= 0xff
		b.done = true
	}
	return n, err
}

func (b *corruptBody) Close() error { return b.rc.Close() }

var out = map[string]any{}

func run(name string, fn func() (any, error)) {
	v, err := fn()
	var e *api.Error
	switch {
	case err == nil:
		out[name] = map[string]any{"ok": v}
	case errors.As(err, &e):
		out[name] = map[string]any{"error": e.Status, "type": e.Type, "title": e.Title, "detail": e.Detail, "retryable": e.Retryable, "message": err.Error()}
	default:
		out[name] = map[string]any{"fail": err.Error()}
	}
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func main() {
	base, caFile := os.Args[1], os.Args[2]
	pem, _ := os.ReadFile(caFile)
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	transport := api.NewTransport(&tls.Config{RootCAs: pool})
	var dials atomic.Int32
	dialer := &net.Dialer{}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dials.Add(1)
		return dialer.DialContext(ctx, network, addr)
	}
	rec := &recorder{next: transport}
	c, err := api.NewClient(base, api.WithHTTPClient(&http.Client{Transport: rec}), api.WithBackoff(10*time.Millisecond))
	if err != nil {
		panic(err)
	}
	defer c.Close()
	ctx := context.Background()

	run("get", func() (any, error) {
		v, err := c.UsersGet(ctx, api.UsersGetInput{Id: "ab"})
		return map[string]any{"value": v, "member": v.Role == api.UsersGetOutputRoleMember}, err
	})
	run("void", func() (any, error) { return c.UsersNone(ctx) })
	run("short_read", func() (any, error) { return c.TextLength(ctx, api.TextLengthInput{Text: "a b&c/ü+\u2028\"{}"}) })
	long := strings.Repeat("é", 1500)
	run("long_read", func() (any, error) {
		v, err := c.TextLength(ctx, api.TextLengthInput{Text: long})
		return map[string]any{"length": v.Length, "method": v.Method, "same": v.Text == long}, err
	})
	run("canonical", func() (any, error) {
		return c.SearchGet(ctx, api.SearchGetInput{Q: "x y/é", Limit: 10, Filter: api.SearchGetInputFilter{B: true, A: 0.5}, Nums: []float64{1e21, 1e-7, math.Copysign(0, -1), 0.1, 123456789012345680000, 5}})
	})
	for _, e := range rec.entries() {
		if e.Path == "/search.get" {
			out["canonical_query"] = e.Query
		}
	}
	run("keyword", func() (any, error) { return c.Type(ctx) })
	run("collision", func() (any, error) { return c.CloseOp(ctx) })
	run("profile", func() (any, error) {
		return c.ProfilePut(ctx, api.ProfilePutInput{
			Name:    "n",
			Score:   1.5,
			Address: &api.ProfilePutInputAddress{City: "c"},
			Labels:  []api.ProfilePutInputLabelsItem{api.ProfilePutInputLabelsItemX, api.ProfilePutInputLabelsItemY},
			Extra:   map[string]any{"k": []any{1, "two"}},
			Active:  true,
			Empty:   []string{},
		})
	})
	run("create", func() (any, error) {
		a, err1 := c.OrdersCreate(ctx, api.OrdersCreateInput{Item: "x"}, api.WithIdempotencyKey("k-go"))
		b, err2 := c.OrdersCreate(ctx, api.OrdersCreateInput{Item: "x"}, api.WithIdempotencyKey("k-go"))
		d, err3 := c.OrdersCreate(ctx, api.OrdersCreateInput{Item: "y"})
		return []float64{a, b, d}, errors.Join(err1, err2, err3)
	})
	run("keys", func() (any, error) {
		a, err1 := c.KeysEcho(ctx, api.WithIdempotencyKey("k\"go"))
		b, err2 := c.KeysEcho(ctx)
		return []string{a, b}, errors.Join(err1, err2)
	})
	run("problem", func() (any, error) { return nil, c.OrdersFail(ctx) })
	run("validation", func() (any, error) { return c.UsersGet(ctx, api.UsersGetInput{Id: "a"}) })
	run("retry_safe", func() (any, error) { return c.FlakyGet(ctx) })
	run("retry_keyed", func() (any, error) { return c.OrdersFlaky(ctx) })
	run("retry_transport", func() (any, error) {
		rec.failNext.Store(2)
		v, err := c.UsersGet(ctx, api.UsersGetInput{Id: "rt"})
		return v.Id, err
	})
	run("retry_transport_keyed", func() (any, error) {
		rec.failNext.Store(1)
		return c.OrdersCreate(ctx, api.OrdersCreateInput{Item: "z"})
	})
	run("no_retry_stream", func() (any, error) {
		rec.failNext.Store(1) // a request stream can't be replayed
		s, err := c.SumClient(ctx)
		if err != nil {
			return nil, err
		}
		s.Send(1)
		return s.CloseAndRecv()
	})
	rec.failNext.Store(0)
	run("stream", func() (any, error) {
		s, err := c.CountUp(ctx, api.CountUpInput{To: 5})
		if err != nil {
			return nil, err
		}
		items := []float64{}
		for v, err := range s.All() {
			if err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		return items, nil
	})
	seen := []float64{}
	run("stream_error", func() (any, error) {
		s, err := c.CountFail(ctx)
		if err != nil {
			return nil, err
		}
		for v, err := range s.All() {
			if err != nil {
				return nil, err
			}
			seen = append(seen, v)
		}
		return seen, nil
	})
	out["stream_error_seen"] = seen
	run("stream_break", func() (any, error) {
		s, err := c.CountUp(ctx, api.CountUpInput{To: 1e6})
		if err != nil {
			return nil, err
		}
		items := []float64{}
		for v, err := range s.All() {
			if err != nil {
				return nil, err
			}
			if items = append(items, v); len(items) == 3 {
				break
			}
		}
		return items, nil
	})
	truncated := []float64{}
	run("stream_truncated", func() (any, error) {
		rec.eofAfter.Store(18) // two 9-byte MSG frames, then the body ends without END
		s, err := c.CountUp(ctx, api.CountUpInput{To: 5})
		if err != nil {
			return nil, err
		}
		for v, err := range s.All() {
			if err != nil {
				return nil, err
			}
			truncated = append(truncated, v)
		}
		return truncated, nil
	})
	out["stream_truncated_seen"] = truncated
	run("client_stream", func() (any, error) {
		s, err := c.SumClient(ctx)
		if err != nil {
			return nil, err
		}
		for _, n := range []float64{1, 2, 3, 4} {
			if err := s.Send(n); err != nil {
				return nil, err
			}
		}
		return s.CloseAndRecv()
	})
	run("bidi", func() (any, error) {
		bctx, cancel := context.WithTimeout(ctx, 5*time.Second) // half duplex would hang here
		defer cancel()
		s, err := c.EchoBidi(bctx)
		if err != nil {
			return nil, err
		}
		got := []api.EchoBidiOutput{}
		for i := 1; i <= 3; i++ {
			if err := s.Send(api.EchoBidiInput{N: float64(i)}); err != nil {
				return got, err
			}
			v, err := s.Recv() // before the next input is sent: full duplex
			if err != nil {
				return got, err
			}
			got = append(got, v)
		}
		if err := s.CloseSend(); err != nil {
			return got, err
		}
		_, err = s.Recv()
		return map[string]any{"items": got, "eof": err == io.EOF}, nil
	})
	big := bytes.Repeat([]byte{0, 1, 2, 250, 255}, 180000) // 14 BLOB frames, below the server's 1 MiB per message
	run("blobs_bidi", func() (any, error) {
		s, err := c.BlobsBidi(ctx)
		if err != nil {
			return nil, err
		}
		go func() {
			s.Send(api.BlobsBidiInput{Data: big, Extra: map[string]any{"$blob": 0}})
			s.Send(api.BlobsBidiInput{Data: []byte{}, Extra: map[string]any{"$lit": "x"}})
			s.Send(api.BlobsBidiInput{Data: nil, Extra: []any{map[string]any{"$blob": 1}, "plain"}})
			s.CloseSend()
		}()
		res := []any{}
		for v, err := range s.All() {
			if err != nil {
				return res, err
			}
			res = append(res, map[string]any{"size": v.Size, "len": len(v.Data), "sha": sum(v.Data), "extra": v.Extra})
		}
		return map[string]any{"items": res, "sent": sum(big)}, nil
	})
	payload := append(bytes.Repeat([]byte{7, 8, 9}, 400000), []byte("{\"$blob\": 1}")...)
	run("bytes", func() (any, error) {
		v, err := c.FilesEcho(ctx, api.FilesEchoInput{Data: payload, Extra: map[string]any{"$blob": 1}})
		return map[string]any{"size": v.Size, "same": sum(v.Data) == sum(payload), "extra": v.Extra}, err
	})
	run("file_bytes", func() (any, error) {
		return c.FilesIngest(ctx, api.FilesIngestInput{File: api.FileFromBytes([]byte("hello file"))})
	})
	run("file_stream", func() (any, error) {
		r := struct{ io.Reader }{strings.NewReader(strings.Repeat("x", 300000))} // unknown length: streamed
		return c.FilesIngest(ctx, api.FilesIngestInput{File: api.FileFromReader(r), Cover: api.Ptr(api.FileFromBytes([]byte("cover")))})
	})
	once := api.FileFromReader(strings.NewReader("once"))
	run("file_once", func() (any, error) { return c.FilesIngest(ctx, api.FilesIngestInput{File: once}) })
	run("file_twice", func() (any, error) { return c.FilesIngest(ctx, api.FilesIngestInput{File: once}) })
	created, deleted := 0, 0
	for _, e := range rec.entries() {
		if e.Method == "POST" && e.Path == "/$uploads" {
			created++
		}
		if e.Method == "DELETE" && strings.HasPrefix(e.Path, "/$uploads/") {
			deleted++
		}
	}
	out["uploads"] = map[string]int{"created": created, "deleted": deleted}

	var d api.Download
	run("download", func() (any, error) {
		v, err := c.ExportGet(ctx)
		if err != nil {
			return nil, err
		}
		d = v.Archive
		data, err := d.Bytes(ctx)
		return map[string]any{"prefix": strings.HasPrefix(d.URL, base+"/$downloads/"), "size": d.Size, "type": d.Type, "sha": sum(data), "announced": d.SHA256, "noNote": v.Note == nil, "live": d.Expires.After(time.Now())}, err
	})
	run("download_resume", func() (any, error) {
		rec.cut.Store(1 << 20)
		before := len(rec.entries())
		data, err := d.Bytes(ctx)
		if err != nil {
			return nil, err
		}
		requests := rec.entries()[before:]
		return map[string]any{"sha": sum(data), "requests": requests}, nil
	})
	run("download_corrupt", func() (any, error) {
		rec.corrupt.Store(true)
		_, err := d.Bytes(ctx)
		return nil, err
	})
	run("deadline", func() (any, error) { return c.SlowGet(ctx, api.WithTimeout(50*time.Millisecond)) })
	run("cancel", func() (any, error) {
		cctx, cancel := context.WithCancel(ctx)
		time.AfterFunc(50*time.Millisecond, cancel)
		_, err := c.SlowGet(cctx)
		return errors.Is(err, context.Canceled), nil
	})
	run("after_errors", func() (any, error) {
		v, err := c.UsersGet(ctx, api.UsersGetInput{Id: "zz"})
		return v.Id, err
	})
	out["dials"] = dials.Load()
	run("default_client", func() (any, error) {
		dc, err := api.NewClient(base, api.WithCAFile(caFile))
		if err != nil {
			return nil, err
		}
		defer dc.Close()
		v, err := dc.UsersGet(ctx, api.UsersGetInput{Id: "dd"})
		return v.Http, err
	})
	json.NewEncoder(os.Stdout).Encode(out)
}
`;

/** Names and shapes that need escaping or deduplication — compiled and vetted, never run. */
const TRICKY: Manifest = {
  apue: 'draft-00',
  ops: {
    'users.get': { effect: 'safe', stream: 'none', input: { type: 'null' }, output: { type: 'string' } },
    'users_get': {
      effect: 'safe',
      stream: 'none',
      description: 'Line one.\n  - not a list\n# not a heading',
      deprecated: { since: '2026-01-01T00:00:00.000Z' },
      input: { type: 'null' },
      output: {
        type: 'object',
        properties: {
          'odd-key': { type: 'string' },
          'oddKey': { type: 'string' },
          '-': { type: 'number' },
          'ä': { type: 'boolean' },
          '3d': { type: 'integer' },
          'role': { type: 'string', enum: ['a-b', 'a_b', '', '1', 'say "hi"'] },
          'deep': { type: 'array', items: { anyOf: [{ type: 'object', properties: { x: { type: 'array', items: { type: 'array', items: {} } } } }, { type: 'null' }] } },
          'maybe': { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        },
        required: ['odd-key', 'deep'],
      },
    },
    'upload': { effect: 'unsafe', stream: 'none', input: { type: 'string', contentEncoding: 'base64', contentMediaType: 'application/octet-stream', 'x-apue-transfer': 'blob-frames' }, output: { type: 'null' } },
    '3d.render': { effect: 'idempotent', stream: 'none', input: { type: 'array', items: { type: 'string', enum: ['a'] } }, output: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } },
    'chat': { effect: 'unsafe', stream: 'bidi', input: { type: 'null' }, output: { type: 'null' } },
    'ping': { effect: 'safe', stream: 'server', input: { type: 'null' }, output: { type: 'null' } },
  },
};

test('a generated Go client against a live server', { skip: go ? false : 'go not installed', timeout: 240_000 }, async (ctx) => {
  const server = await startServer(api, handlers, { uploads: {} });
  const dir = mkdtempSync(join(tmpdir(), 'apue-go-'));
  ctx.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ca = join(dir, 'ca.pem');
  writeFileSync(ca, testCert().cert);
  writeFileSync(join(dir, 'go.mod'), 'module apuetest\n\ngo 1.24\n');
  writeFileSync(join(dir, 'main.go'), MAIN);
  for (const sub of ['api', 'runtime', 'tricky']) mkdirSync(join(dir, sub));
  // The runtime template compiles (and vets) on its own; so does a file full of awkward names.
  writeFileSync(join(dir, 'runtime', 'runtime.go'), readFileSync(join(import.meta.dirname, '..', 'src', 'go', 'runtime.go')));
  const tricky = generateGo(TRICKY, { packageName: 'tricky' });
  writeFileSync(join(dir, 'tricky', 'tricky.go'), tricky);
  // Through the CLI, like a user: manifest over HTTPS → api/api.go.
  await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'apue-types.ts'), server.url, '--lang', 'go', '--package', 'api', '--ca', ca, '--out', join(dir, 'api', 'api.go')]);
  const generated = readFileSync(join(dir, 'api', 'api.go'), 'utf8');
  assert.match(generated, /^\/\/ Code generated by apue-types --lang go from https:\/\/127\.0\.0\.1:\d+\/\.well-known\/apue \(manifest [^)]+\)\. DO NOT EDIT\.\n/);
  assert.match(generated, /^package api$/m);
  assert.match(generated, /^func \(c \*Client\) CloseOp\(ctx context\.Context, opts \.\.\.CallOption\) \(string, error\) \{$/m);
  assert.match(generated, /^func \(c \*Client\) Type\(/m);
  assert.match(tricky, /^func \(c \*Client\) UsersGet2\(/m);
  assert.match(tricky, /^func \(c \*Client\) UploadOp\(ctx context\.Context, in \[\]byte, opts \.\.\.CallOption\) error \{$/m);
  assert.match(tricky, /^func \(c \*Client\) Op3dRender\(ctx context\.Context, in \[\]Op3dRenderInputItem, opts \.\.\.CallOption\) \(\*Op3dRenderOutput, error\) \{$/m);
  assert.match(tricky, /^\tOddKey2 \*string +`json:"oddKey,omitempty"`$/m);
  assert.match(tricky, /^\tX +\*float64 +`json:"-,omitempty"`$/m);
  assert.match(tricky, /^\tX2 +\*bool +`json:"ä,omitempty"`$/m);
  assert.match(tricky, /^\tMaybe +\[\]string +`json:"maybe,omitzero"`$/m);
  assert.match(tricky, /^\tDeep +\[\]\*UsersGet2OutputDeepItem +`json:"deep"`$/m);
  assert.match(tricky, /^\tUsersGet2OutputRoleAB2 +UsersGet2OutputRole = "a_b"$/m);
  assert.match(tricky, /^\tUsersGet2OutputRoleSayHi +UsersGet2OutputRole = "say \\"hi\\""$/m);
  assert.match(tricky, /^\/\/ Deprecated: since 2026-01-01T00:00:00\.000Z\.$/m);

  const gofmt = execFileSync(go!.gofmt, ['-l', join(dir, 'api', 'api.go'), join(dir, 'tricky', 'tricky.go'), join(dir, 'runtime', 'runtime.go')], { encoding: 'utf8' });
  assert.equal(gofmt, '', 'generated code is gofmt-clean');
  await promisify(execFile)(go!.go, ['vet', './...'], { cwd: dir, env: GO_ENV, timeout: 180_000 });
  const { stdout } = await promisify(execFile)(go!.go, ['run', '.', server.url, ca], { cwd: dir, env: GO_ENV, timeout: 180_000 });
  const out = JSON.parse(stdout) as Record<string, any>;
  assert.deepEqual(out.get, { ok: { value: { id: 'ab', role: 'member', tags: ['a'], method: 'GET', http: '2.0' }, member: true } });
  assert.deepEqual(out.void, { ok: 'none' });
  assert.deepEqual(out.short_read, { ok: { length: 12, method: 'GET', text: 'a b&c/ü+\u2028"{}' } }, 'canonical JSON in ?i= survives escaping');
  assert.deepEqual(out.long_read, { ok: { length: 1500, method: 'POST', same: true } }, 'URL > 2 KiB: POST');
  const search = { q: 'x y/é', limit: 10, filter: { b: true, a: 0.5 }, nums: [1e21, 1e-7, -0, 0.1, 123456789012345680000, 5] };
  assert.deepEqual(out.canonical, { ok: 'x y/é' });
  assert.equal(out.canonical_query, `i=${encodeURIComponent(canonicalJson(search))}`, 'the same GET URL as the TypeScript client: RFC 8785 keys and numbers');
  assert.deepEqual(out.keyword, { ok: { 'odd-key': null } });
  assert.deepEqual(out.collision, { ok: 'closed' });
  const { profile, keys } = out.profile!.ok;
  assert.deepEqual(profile, { name: 'n', score: 1.5, address: { city: 'c', zip: null }, labels: ['x', 'y'], manager: null, extra: { k: [1, 'two'] }, active: true, empty: [] });
  assert.deepEqual([...keys].sort(), ['active', 'address', 'empty', 'extra', 'labels', 'manager', 'name', 'score'], 'nil optionals are left out, an empty slice is sent');
  const [first, replay, other] = out.create!.ok as number[];
  assert.equal(replay, first, 'same Idempotency-Key: the stored result');
  assert.equal(other, first! + 1, 'a fresh key per call');
  const [explicit, generatedKey] = out.keys!.ok as string[];
  assert.equal(explicit, '"k\\"go"', 'the key as an RFC 9651 sf-string');
  assert.match(generatedKey!, /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
  assert.deepEqual(out.problem, { error: 409, type: 'https://example.com/problems/out-of-stock', title: 'Out Of Stock', detail: 'item gone', retryable: false, message: 'apue: 409 Out Of Stock: item gone' });
  assert.equal(out.validation!.error, 400);
  assert.equal(out.validation!.type, 'https://michaellocher.github.io/apue/problems/validation-failed');
  assert.deepEqual(out.retry_safe, { ok: 3 }, '503 + Retry-After retried twice');
  const flaky = out.retry_keyed!.ok as { attempts: number; keys: string[] };
  assert.equal(flaky.attempts, 2);
  assert.equal(flaky.keys[0], flaky.keys[1], 'a retry reuses its Idempotency-Key');
  assert.deepEqual(out.retry_transport, { ok: 'rt' }, 'a lost connection is retried (safe)');
  assert.equal(typeof out.retry_transport_keyed.ok, 'number', 'a lost connection is retried (keyed)');
  assert.match(out.no_retry_stream.fail, /injected: connection lost/, 'request streams are never retried');
  assert.deepEqual(out.stream, { ok: [1, 2, 3, 4, 5] });
  assert.deepEqual([out.stream_error!.error, out.stream_error!.detail, out.stream_error_seen], [409, 'midway', [1]]);
  assert.deepEqual(out.stream_break, { ok: [1, 2, 3] });
  assert.deepEqual([out.stream_truncated.error, out.stream_truncated.title, out.stream_truncated_seen], [502, 'Truncated Stream', [1, 2]], 'a body without END is an error');
  assert.deepEqual(out.client_stream, { ok: 10 });
  assert.deepEqual(out.bidi, { ok: { items: [{ n: 2, http: '2.0' }, { n: 4, http: '2.0' }, { n: 6, http: '2.0' }], eof: true } }, 'full duplex over HTTP/2');
  const empty = createHash('sha256').digest('hex');
  const blobs = out.blobs_bidi!.ok as { items: unknown[]; sent: string };
  assert.deepEqual(blobs.items, [
    { size: 900_000, len: 900_000, sha: blobs.sent, extra: { $blob: 0 } },
    { size: 0, len: 0, sha: empty, extra: { $lit: 'x' } },
    { size: 0, len: 0, sha: empty, extra: [{ $blob: 1 }, 'plain'] },
  ], 'BLOB frames both ways, look-alikes escaped both ways');
  assert.deepEqual(out.bytes, { ok: { size: 1_200_012, same: true, extra: { $blob: 1 } } }, 'bytes through an upload in and BLOB frames out');
  assert.deepEqual(out.file_bytes, { ok: { size: 10, sha256: createHash('sha256').update('hello file').digest('hex') } });
  assert.deepEqual(out.file_stream, { ok: { size: 300000, sha256: createHash('sha256').update('x'.repeat(300000)).digest('hex'), cover: 5 } });
  assert.deepEqual(out.file_once, { ok: { size: 4, sha256: createHash('sha256').update('once').digest('hex') } });
  assert.match(out.file_twice!.fail!, /only be uploaded once/);
  assert.deepEqual(out.uploads, { created: 5, deleted: 5 }, 'every upload made for a call is deleted after it');
  const exportSha = createHash('sha256').update(EXPORT).digest('hex');
  assert.deepEqual(out.download, { ok: { prefix: true, size: EXPORT.byteLength, type: 'application/x-test', sha: exportSha, announced: exportSha, noNote: true, live: true } });
  const resumed = out.download_resume!.ok as { sha: string; requests: Array<{ Method: string; Path: string; Range: string; IfRange: string }> };
  assert.equal(resumed.sha, exportSha);
  assert.equal(resumed.requests.length, 2, 'cut once, resumed once');
  assert.equal(resumed.requests[0]!.Range, '');
  assert.equal(resumed.requests[1]!.Range, `bytes=${1 << 20}-`);
  assert.match(resumed.requests[1]!.IfRange, /^".+"$/, 'If-Range carries the strong ETag');
  assert.equal(out.download_corrupt!.error, 502);
  assert.match(out.download_corrupt!.detail!, /SHA-256/);
  assert.equal(out.deadline!.error, 504);
  assert.deepEqual(out.cancel, { ok: true });
  assert.deepEqual(out.after_errors, { ok: 'zz' });
  assert.equal(out.dials, 1, 'one connection for everything: errors, cancellations and resets keep it usable');
  assert.deepEqual(out.default_client, { ok: '2.0' });
});

test('Go names: exported, deduplicated, no clash with the runtime', () => {
  assert.equal(goName('users.get'), 'UsersGet');
  assert.equal(goName('type'), 'Type');
  assert.equal(goName('close'), 'CloseOp');
  assert.equal(goName('delete-upload'), 'DeleteUploadOp');
  assert.equal(goName('3d.render'), 'Op3dRender');
  assert.equal(goName('a-b.c'), 'ABC');
});

test('Go codegen refuses what Go types cannot express', () => {
  const manifest = (output: Record<string, unknown>): Manifest => ({ apue: 'draft-00', ops: { 'x.get': { effect: 'safe', stream: 'none', input: { type: 'null' }, output } } });
  assert.throws(() => generateGo(manifest({ type: 'string', format: 'email' })), /unsupported JSON Schema/);
  assert.throws(() => generateGo(manifest({ anyOf: [{ type: 'string' }, { type: 'number' }] })), /unsupported JSON Schema/);
  assert.throws(() => generateGo(manifest({ type: 'object', properties: { a: { type: 'null' } } })), /can only be null/);
  assert.throws(() => generateGo(manifest({ type: 'object', properties: { 'a,b': { type: 'string' } } })), /json struct tag/);
  assert.throws(() => generateGo(manifest({ type: 'object', properties: { '': { type: 'string' } } })), /json struct tag/);
  assert.throws(() => generateGo(manifest({ type: 'string', enum: ['\ud800'] })), /lone surrogate/);
  assert.throws(() => generateGo(manifest({ type: 'string', contentMediaType: 'application/octet-stream', 'x-apue-transfer': 'upload' })), /t\.file\(\) outside an input/);
  assert.throws(() => generateGo(manifest({ type: 'string' }), { packageName: 'func' }), /package name/);
  assert.throws(() => generateGo(manifest({ type: 'string' }), { packageName: 'a-b' }), /package name/);
});
