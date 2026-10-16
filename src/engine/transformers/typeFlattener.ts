/**
 * TypeScript interface flattening for the Ultra-Slim level.
 *
 * Converts a `TSInterfaceDeclaration` into a single-line type alias with
 * an inline structural type literal, e.g.:
 *
 *   interface User {
 *     id: number;
 *     name: string;
 *     email?: string;
 *   }
 *
 * becomes:
 *
 *   type User = { id: number; name: string; email?: string };
 */
import generate from '@babel/generator';
import * as t from '@babel/types';

function generateCompact(node: t.Node): string {
  return generate(node, { compact: true, comments: false }).code;
}

/**
 * Render one interface as a single line of text. Exported for tests and
 * for callers that want the flattened form without a full AST round-trip.
 */
export function flattenInterfaceToSingleLine(
  node: t.TSInterfaceDeclaration,
): string {
  const members = node.body.body.map((member) => generateCompact(member));
  const name = node.id.name;
  const body = members.length > 0 ? `{ ${members.join('; ')} }` : '{}';
  return `interface ${name} ${body}`;
}

/**
 * Convert an interface declaration node into an equivalent
 * `TSTypeAliasDeclaration` whose type literal generator-compacts onto a
 * single line. Generic type parameters are preserved; `extends` clauses
 * are dropped (Ultra-Slim is a structural sketch by design — see README).
 */
export function interfaceToTypeAlias(
  node: t.TSInterfaceDeclaration,
): t.TSTypeAliasDeclaration {
  const literal = t.tsTypeLiteral([...node.body.body]);
  return t.tsTypeAliasDeclaration(
    t.identifier(node.id.name),
    node.typeParameters ?? null,
    literal,
  );
}
