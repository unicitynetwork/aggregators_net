import openRpcDocument from './openrpc.json';

export { openRpcDocument };

export function explorerHtml(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>AggregatorGateway RPC Explorer</title>
    <script src="https://unpkg.com/@open-rpc/playground@latest" defer></script>
  </head>
  <body>
    <open-rpc-playground rpc-doc-url="/openrpc"></open-rpc-playground>
  </body>
</html>`;
}
