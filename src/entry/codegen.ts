// Code generation from a server's manifest (`/.well-known/apue`): TypeScript API modules and
// self-contained Python and Go clients. Node-only. The CLI is `apue-types`.
export { generateApi, schemaCode, type CodegenOptions, type Manifest, type ManifestOp } from '../codegen.ts';
export { generatePython, pythonName } from '../codegen-python.ts';
export { generateGo, goName } from '../codegen-go.ts';
