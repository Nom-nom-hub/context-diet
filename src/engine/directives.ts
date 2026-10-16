/**
 * Directive annotation support:
 *
 *   // @diet-keep   — preserve the annotated node regardless of level.
 *   // @diet-strip  — purge the annotated node entirely, at any level.
 *
 * Directives are read from a node's leading comments (or, for exported
 * declarations, from the wrapping export statement's leading comments,
 * since authors naturally write the comment above `export function …`).
 */
import traverse, { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

type AnyNode = t.Node & {
  leadingComments?: ReadonlyArray<{ value: string }> | null;
};

function commentsContain(node: AnyNode | null | undefined, needle: string): boolean {
  if (!node || !node.leadingComments) {
    return false;
  }
  return node.leadingComments.some(
    (c) => typeof c.value === 'string' && c.value.includes(needle),
  );
}

/** True when the node itself carries the given directive comment. */
export function nodeHasDirective(
  node: t.Node | null | undefined,
  directive: '@diet-keep' | '@diet-strip',
): boolean {
  return commentsContain(node as AnyNode, directive);
}

/**
 * True when the node OR its immediate export wrapper carries the directive.
 */
export function pathHasDirective(
  path: NodePath,
  directive: '@diet-keep' | '@diet-strip',
): boolean {
  if (nodeHasDirective(path.node as t.Node, directive)) {
    return true;
  }
  const parent = path.parent as t.Node | undefined;
  if (
    parent &&
    (parent.type === 'ExportNamedDeclaration' ||
      parent.type === 'ExportDefaultDeclaration')
  ) {
    return nodeHasDirective(parent, directive);
  }
  return false;
}

export function hasKeepDirective(path: NodePath): boolean {
  return pathHasDirective(path, '@diet-keep');
}

export function hasStripDirective(path: NodePath): boolean {
  return pathHasDirective(path, '@diet-strip');
}

/**
 * True when any ancestor of this path carries @diet-keep — used so that
 * transforms (log stripping, stubbing, …) leave kept subtrees untouched.
 */
export function isInsideKeptNode(path: NodePath): boolean {
  let current: NodePath | null = path;
  while (current) {
    if (nodeHasDirective(current.node as t.Node, '@diet-keep')) {
      return true;
    }
    const parentNode = current.parent as t.Node | undefined;
    if (
      parentNode &&
      (parentNode.type === 'ExportNamedDeclaration' ||
        parentNode.type === 'ExportDefaultDeclaration') &&
      nodeHasDirective(parentNode, '@diet-keep')
    ) {
      return true;
    }
    current = current.parentPath;
  }
  return false;
}

/**
 * Snapshot directive targets BEFORE any mutation. This matters: when
 * Babel removes a node mid-traversal, the removed node's orphan leading
 * comment gets re-attached to the following sibling, so reading
 * `leadingComments` live during the mutating pass would make a
 * `// @diet-strip` above a deleted helper also strip the next export.
 * Membership in these WeakSets is position-independent and stable.
 */
export interface DirectiveSets {
  keep: WeakSet<object>;
  strip: WeakSet<object>;
}

export function collectDirectives(ast: t.File): DirectiveSets {
  const keep = new WeakSet<object>();
  const strip = new WeakSet<object>();
  const addWithExportPartner = (set: WeakSet<object>, path: NodePath) => {
    set.add(path.node as object);
    const parent = path.parent as t.Node | undefined;
    if (
      parent &&
      (parent.type === 'ExportNamedDeclaration' ||
        parent.type === 'ExportDefaultDeclaration')
    ) {
      set.add(parent as object);
    }
    const node = path.node as t.Node & {
      declaration?: t.Node | null;
    };
    if (
      (node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportDefaultDeclaration') &&
      node.declaration
    ) {
      set.add(node.declaration as object);
    }
  };
  traverse(ast, {
    enter(path) {
      if (nodeHasDirective(path.node as t.Node, '@diet-keep')) {
        addWithExportPartner(keep, path);
      }
      if (nodeHasDirective(path.node as t.Node, '@diet-strip')) {
        addWithExportPartner(strip, path);
      }
    },
  });
  return { keep, strip };
}

/** Node types @diet-strip / @diet-keep are honoured on. */
export const DIRECTIVE_NODE_TYPES = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'ClassMethod',
  'ObjectMethod',
  'VariableDeclaration',
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
]);
