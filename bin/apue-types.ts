// Generates a typed apü API definition from a server's manifest.
//   node bin/apue-types.ts https://api.example [--runtime ./apue/src] [--out api.ts] [--ca cert.pem]
import { readFileSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { generateApi, type Manifest } from '../src/codegen.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runtime: { type: 'string', default: './apue' }, out: { type: 'string' }, ca: { type: 'string' }, name: { type: 'string', default: 'api' } },
});
const base = positionals[0];
if (!base) throw new Error('usage: apue-types <base-url> [--runtime path] [--out file] [--ca cert.pem]');
if (values.ca) tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(values.ca, 'utf8')]);
const url = `${base.replace(/\/$/, '')}/.well-known/apue`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const code = generateApi((await res.json()) as Manifest, { runtime: values.runtime, source: url, exportName: values.name });
if (values.out) writeFileSync(values.out, code);
else process.stdout.write(code);
