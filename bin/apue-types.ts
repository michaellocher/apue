#!/usr/bin/env node
// Generates a typed apü API definition from a server's manifest.
//   apue-types https://api.example [--runtime @michaellocher/apue | ./apue/src] [--out api.ts] [--ca cert.pem]
//   apue-types https://api.example --lang python [--out api.py]   (self-contained module)
//   apue-types https://api.example --lang go [--package api] [--out api.go]   (self-contained file)
//   apue-types https://api.example --lang java [--package com.example.api] [--out Api.java]   (self-contained source file)
//   apue-types https://api.example --lang swift [--out Api.swift]   (self-contained source file)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { generateApi, type Manifest } from '../src/codegen.ts';
import { generateGo } from '../src/codegen-go.ts';
import { generatePython } from '../src/codegen-python.ts';
import { generateJava } from '../src/codegen-java.ts';
import { generateSwift } from '../src/codegen-swift.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runtime: { type: 'string', default: '@michaellocher/apue' }, out: { type: 'string' }, ca: { type: 'string' }, name: { type: 'string', default: 'api' }, lang: { type: 'string', default: 'typescript' }, package: { type: 'string' } },
});
const base = positionals[0];
if (!base) throw new Error('usage: apue-types <base-url> [--lang typescript|python|go|java|swift] [--runtime path] [--package name] [--out file] [--ca cert.pem]');
if (values.ca) tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(values.ca, 'utf8')]);
const url = `${base.replace(/\/$/, '')}/.well-known/apue`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const manifest = (await res.json()) as Manifest;
if (!['typescript', 'python', 'go', 'java', 'swift'].includes(values.lang)) throw new Error(`--lang: typescript, python, go, java or swift, got ${values.lang}`);
const code =
  values.lang === 'python' ? generatePython(manifest, { source: url })
  : values.lang === 'go' ? generateGo(manifest, { source: url, packageName: values.package ?? 'api' })
  : values.lang === 'java' ? generateJava(manifest, { source: url, packageName: values.package, className: values.out ? basename(values.out, '.java') : undefined })
  : values.lang === 'swift' ? generateSwift(manifest, { source: url })
  : generateApi(manifest, { runtime: values.runtime, source: url, exportName: values.name });
if (values.out) writeFileSync(values.out, code);
else process.stdout.write(code);
