import path from 'node:path';
import * as vscode from 'vscode';

export const LLSP3_SOURCE_SCHEME = 'llsp3';

const CONTAINER_QUERY_KEY = 'container';

export function createSourceUri(container: vscode.Uri): vscode.Uri {
  const extension = path.posix.extname(container.path);
  const baseName =
    path.posix.basename(container.path, extension) || 'LLSP3 Project';
  const query = new URLSearchParams({
    [CONTAINER_QUERY_KEY]: container.toString(),
  });

  return vscode.Uri.from({
    scheme: LLSP3_SOURCE_SCHEME,
    path: `/${baseName}.py`,
    query: query.toString(),
  });
}

export function getContainerUri(source: vscode.Uri): vscode.Uri {
  if (source.scheme !== LLSP3_SOURCE_SCHEME) {
    throw new Error(`Unsupported LLSP3 source URI scheme: ${source.scheme}`);
  }

  const container = new URLSearchParams(source.query).get(CONTAINER_QUERY_KEY);
  if (container === null || container.length === 0) {
    throw new Error('The LLSP3 source URI does not identify its container.');
  }

  return vscode.Uri.parse(container, true);
}

export function isLlsp3Container(uri: vscode.Uri): boolean {
  return path.posix.extname(uri.path).toLowerCase() === '.llsp3';
}
