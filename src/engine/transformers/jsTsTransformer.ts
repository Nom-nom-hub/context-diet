/**
 * Babel-based JS/TS AST transformer — the heart of ContextDiet.
 *
 * Levels:
 *  - diet:       strip comments/JSDoc + console.log/debug/trace.
 *  - skeleton:   diet + drop unused imports, prune unreferenced internal
 *                helpers, stub bodies of non-exported functions/methods
 *                with a `/* ...impl... *\/` placeholder.
 *  - ultra-slim: skeleton + interfaces flattened to single-line type
 *                aliases, local identifiers minified inside function
 *                scopes (Babel scope renaming), compact code generation
 *                (which also condenses loop/statement layout).
 *
 * Directives honoured at every level:
 *  - `// @diet-keep`  — node (and its subtree) is preserved.
 *  - `// @diet-strip` — node is removed entirely.
 *
 * This module never imports `vscode` and throws on parse errors so the
 * caller (compress.ts) can route to the regex fail-safe fallback.
 */
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import { collectDirectives } from '../directives';
import { interfaceToTypeAlias } from './typeFlattener';

export type CompressionLevel = 'diet' | 'skeleton' | 'ultra-slim';

export interface TransformOptions {
  level?: CompressionLevel;
  stripComments?: boolean;
  stripLogs?: boolean;
  filename?: string;
}

const STRIPPED_CONSOLE_METHODS = new Set(['log', 'debug', 'trace']);

function isConsoleCall(node: t.Node | null | undefined): boolean {
  if (!node || node.type !== 'CallExpression') {
    return false;
  }
  const callee = node.callee;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'console' &&
    callee.property.type === 'Identifier' &&
    STRIPPED_CONSOLE_METHODS.has(callee.property.name)
  );
}

function isExported(path: NodePath): boolean {
  const parent = path.parent as t.Node | undefined;
  return (
    !!parent &&
    (parent.type === 'ExportNamedDeclaration' ||
      parent.type === 'ExportDefaultDeclaration')
  );
}

/**
 * True when `binding` is referenced from outside the subtree rooted at
 * `ownStart`/`ownEnd` (so recursive self-references don't count).
 */
function referencedExternally(
  binding: { referencePaths: ReadonlyArray<NodePath> } | undefined | null,
  ownNode: t.Node,
): boolean {
  if (!binding) {
    return false;
  }
  const start = ownNode.start ?? -1;
  const end = ownNode.end ?? Number.MAX_SAFE_INTEGER;
  return binding.referencePaths.some((ref) => {
    const s = ref.node.start ?? -1;
    return s < start || s > end;
  });
}

/** Build a stub body: `{ /* ...impl... *\/ }` */
export function makeStubBlock(): t.BlockStatement {
  const block = t.blockStatement([]);
  t.addComment(block, 'inner', ' ...impl... ', false);
  return block;
}

function shortNameGenerator(): () => string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let index = 0;
  return () => {
    let n = index;
    index += 1;
    let name = '';
    do {
      name = letters[n % 26] + name;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return name;
  };
}

/**
 * Ultra-Slim: rename parameters and locally-declared variables inside
 * function scopes to short names using Babel's scope renamer (which
 * correctly updates every reference, destructuring pattern and object
 * shorthand — verified against @babel/traverse's Renamer).
 */
function renameLocalsInFunctions(ast: t.File): void {
  const fnPaths: NodePath[] = [];
  traverse(ast, {
    Function(p) {
      fnPaths.push(p);
    },
  });
  for (const fnPath of fnPaths) {
    const fnNode = fnPath.node as t.Function;
    const fnStart = fnNode.start ?? 0;
    const fnEnd = fnNode.end ?? Number.MAX_SAFE_INTEGER;
    const nextName = shortNameGenerator();
    // Snapshot bindings first: renaming mutates the binding map.
    const bindings = Object.values(fnPath.scope.bindings);
    for (const binding of bindings) {
      try {
        const declStart = binding.identifier.start ?? -1;
        if (declStart <= fnStart || declStart >= fnEnd) {
          continue; // declared outside this function
        }
        const isParam = binding.kind === 'param';
        const isLocalDecl =
          binding.path.isVariableDeclarator() ||
          binding.path.isFunctionDeclaration() ||
          binding.path.isClassDeclaration();
        if (!isParam && !isLocalDecl) {
          continue;
        }
        const oldName = binding.identifier.name;
        if (oldName.length <= 1) {
          continue;
        }
        let candidate = nextName();
        let guard = 0;
        while (
          guard < 200 &&
          (candidate === oldName ||
            candidate.length >= oldName.length ||
            fnPath.scope.hasBinding(candidate) ||
            fnPath.scope.hasReference(candidate) ||
            fnPath.scope.hasGlobal(candidate) ||
            fnPath.scope.hasLabel(candidate))
        ) {
          candidate = nextName();
          guard += 1;
        }
        if (candidate === oldName || candidate.length >= oldName.length) {
          continue;
        }
        fnPath.scope.rename(oldName, candidate);
      } catch {
        // Renaming is best-effort: a failed rename must never fail the run.
        continue;
      }
    }
  }
}

export function transformWithBabel(
  code: string,
  options: TransformOptions = {},
): string {
  const level: CompressionLevel = options.level ?? 'skeleton';
  const stripComments = options.stripComments !== false;
  const stripLogs = options.stripLogs !== false;
  const filename = options.filename ?? '';
  const isTs = /\.(ts|tsx|mts|cts)$/i.test(filename) || !/\.(js|jsx|mjs|cjs)$/i.test(filename);
  const isJsx = /\.(tsx|jsx)$/i.test(filename);

  const ast = parse(code, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    plugins: [
      ...(isTs ? (['typescript'] as const) : []),
      ...(isJsx || isTs ? (['jsx'] as const) : []),
      'decorators-legacy',
      'classProperties',
      'objectRestSpread',
      'optionalChaining',
      'nullishCoalescingOperator',
      'dynamicImport',
      'topLevelAwait',
    ] as never[],
  });

  const stubBlocks = new WeakSet<object>();

  // Snapshot directives before mutating (see directives.collectDirectives):
  // live leadingComments are unreliable once nodes start being removed.
  const directiveSets = collectDirectives(ast);
  const pathStrip = (path: NodePath): boolean =>
    directiveSets.strip.has(path.node as object) ||
    (!!path.parent && directiveSets.strip.has(path.parent as object));
  const pathKeep = (path: NodePath): boolean =>
    directiveSets.keep.has(path.node as object) ||
    (!!path.parent && directiveSets.keep.has(path.parent as object));
  const insideKept = (path: NodePath): boolean => {
    let current: NodePath | null = path;
    while (current) {
      if (directiveSets.keep.has(current.node as object)) {
        return true;
      }
      const parentNode = current.parent as t.Node | undefined;
      if (parentNode && directiveSets.keep.has(parentNode as object)) {
        return true;
      }
      current = current.parentPath;
    }
    return false;
  };

  traverse(ast, {
    // ---------------------------------------------------------------
    // Expression statements: @diet-strip on a statement, console.*
    // ---------------------------------------------------------------
    ExpressionStatement(path) {
      if (pathStrip(path)) {
        path.remove();
        return;
      }
      if (!stripLogs) {
        return;
      }
      if (insideKept(path)) {
        return;
      }
      if (isConsoleCall(path.node.expression)) {
        path.remove();
      }
    },

    // ---------------------------------------------------------------
    // Any other console.log/debug/trace call used as a statement is
    // handled above; nested calls (e.g. inside a return) are left
    // alone deliberately — removing them would change semantics.
    // ---------------------------------------------------------------

    // ---------------------------------------------------------------
    // Imports: @diet-strip + unused-import pruning (skeleton & up)
    // ---------------------------------------------------------------
    ImportDeclaration(path) {
      if (pathStrip(path)) {
        path.remove();
        return;
      }
      if (level === 'diet' || pathKeep(path)) {
        return;
      }
      if (path.node.specifiers.length === 0) {
        return; // side-effect import: always keep
      }
      const keptSpecifiers = path.node.specifiers.filter((spec) => {
        if (spec.type === 'ImportNamespaceSpecifier') {
          const binding = path.scope.getBinding(spec.local.name);
          return referencedExternally(binding, path.node) || !binding
            ? true
            : binding.referenced;
        }
        const binding = path.scope.getBinding(spec.local.name);
        if (!binding) {
          return true; // unresolved — be conservative, keep it
        }
        return binding.referenced && binding.referencePaths.length > 0;
      });
      if (keptSpecifiers.length === 0) {
        path.remove();
      } else if (keptSpecifiers.length !== path.node.specifiers.length) {
        path.node.specifiers = keptSpecifiers;
      }
    },

    // ---------------------------------------------------------------
    // Functions: strip / prune / stub
    // ---------------------------------------------------------------
    FunctionDeclaration(path) {
      if (pathStrip(path)) {
        if (isExported(path)) {
          (path.parentPath as NodePath).remove();
        } else {
          path.remove();
        }
        return;
      }
      if (level === 'diet' || pathKeep(path) || isExported(path)) {
        return;
      }
      const name = path.node.id?.name;
      if (!name) {
        return;
      }
      const binding = path.scope.getBinding(name);
      if (!referencedExternally(binding, path.node)) {
        path.remove(); // unreferenced internal helper: prune
        return;
      }
      const stub = makeStubBlock();
      stubBlocks.add(stub);
      path.node.body = stub;
    },

    // ---------------------------------------------------------------
    // Classes: strip / prune / stub methods of internal classes
    // ---------------------------------------------------------------
    ClassDeclaration(path) {
      if (pathStrip(path)) {
        if (isExported(path)) {
          (path.parentPath as NodePath).remove();
        } else {
          path.remove();
        }
        return;
      }
      if (level === 'diet' || pathKeep(path) || isExported(path)) {
        return;
      }
      const name = path.node.id?.name;
      if (!name) {
        return;
      }
      const binding = path.scope.getBinding(name);
      if (!referencedExternally(binding, path.node)) {
        path.remove();
      }
      // Referenced internal classes are kept whole at skeleton level;
      // their methods are visited individually below.
    },

    ClassMethod(path) {
      if (pathStrip(path)) {
        path.remove();
        return;
      }
      if (level === 'diet' || pathKeep(path) || insideKept(path)) {
        return;
      }
      if (path.node.kind === 'constructor') {
        return;
      }
      // Stub methods only when the containing class is NOT exported.
      const classPath = path.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
      if (!classPath) {
        return;
      }
      const classParent = classPath.parent as t.Node | undefined;
      const classExported =
        !!classParent &&
        (classParent.type === 'ExportNamedDeclaration' ||
          classParent.type === 'ExportDefaultDeclaration');
      if (classExported) {
        return;
      }
      const stub = makeStubBlock();
      stubBlocks.add(stub);
      (path.node as t.ClassMethod).body = stub;
    },

    ObjectMethod(path) {
      if (pathStrip(path)) {
        path.remove();
        return;
      }
      if (level === 'diet' || pathKeep(path)) {
        return;
      }
      const stub = makeStubBlock();
      stubBlocks.add(stub);
      (path.node as t.ObjectMethod).body = stub;
    },

    // ---------------------------------------------------------------
    // Variable declarations: strip / arrow-function stubbing
    // ---------------------------------------------------------------
    VariableDeclarator(path) {
      const init = path.node.init;
      if (!init || (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression')) {
        return;
      }
      if (pathStrip(path) || pathStrip(path.parentPath as NodePath)) {
        const declPath = path.parentPath as NodePath;
        if (declPath.parent && (declPath.parent as t.Node).type?.startsWith('Export')) {
          (declPath.parentPath as NodePath).remove();
        } else if ((path.parent as t.VariableDeclaration).declarations.length <= 1) {
          declPath.remove();
        } else {
          path.remove();
        }
        return;
      }
      if (level === 'diet' || pathKeep(path)) {
        return;
      }
      const declPath = path.parentPath as NodePath;
      const parentNode = declPath.parent as t.Node | undefined;
      const exported =
        !!parentNode &&
        (parentNode.type === 'ExportNamedDeclaration' ||
          parentNode.type === 'ExportDefaultDeclaration');
      if (exported) {
        return;
      }
      const name = path.node.id.type === 'Identifier' ? path.node.id.name : null;
      if (!name) {
        return;
      }
      const binding = path.scope.getBinding(name);
      if (!referencedExternally(binding, path.node)) {
        if ((path.parent as t.VariableDeclaration).declarations.length <= 1) {
          declPath.remove();
        } else {
          path.remove();
        }
        return;
      }
      if (init.type === 'ArrowFunctionExpression' && init.expression) {
        return; // single-expression arrow: nothing meaningful to stub
      }
      const stub = makeStubBlock();
      stubBlocks.add(stub);
      (init as t.ArrowFunctionExpression | t.FunctionExpression).body = stub;
    },

    VariableDeclaration(path) {
      if (pathStrip(path)) {
        if (isExported(path)) {
          (path.parentPath as NodePath).remove();
        } else {
          path.remove();
        }
      }
    },

    ExportNamedDeclaration(path) {
      if (pathStrip(path)) {
        path.remove();
      }
    },
    ExportDefaultDeclaration(path) {
      if (pathStrip(path)) {
        path.remove();
      }
    },
    ExportAllDeclaration(path) {
      if (pathStrip(path)) {
        path.remove();
      }
    },

    // ---------------------------------------------------------------
    // Ultra-Slim: flatten interfaces to single-line type aliases
    // ---------------------------------------------------------------
    TSInterfaceDeclaration(path) {
      if (pathStrip(path)) {
        if (isExported(path)) {
          (path.parentPath as NodePath).remove();
        } else {
          path.remove();
        }
        return;
      }
      if (level !== 'ultra-slim' || pathKeep(path)) {
        return;
      }
      const alias = interfaceToTypeAlias(path.node);
      if (isExported(path)) {
        (path.parentPath!.node as t.ExportNamedDeclaration).declaration = alias;
      } else {
        path.replaceWith(alias);
      }
    },

    TSTypeAliasDeclaration(path) {
      if (pathStrip(path)) {
        if (isExported(path)) {
          (path.parentPath as NodePath).remove();
        } else {
          path.remove();
        }
      }
    },
  });

  // Ultra-Slim extra pass: minify local identifiers.
  if (level === 'ultra-slim') {
    renameLocalsInFunctions(ast);
  }

  // Comment pruning pass (keeps stub placeholders, honours stripComments).
  if (stripComments) {
    traverse(ast, {
      enter(path) {
        const node = path.node as t.Node & {
          leadingComments?: unknown;
          trailingComments?: unknown;
          innerComments?: unknown;
        };
        const isStub = stubBlocks.has(path.node as object);
        if (!isStub) {
          node.leadingComments = null;
          node.trailingComments = null;
        }
        if (!isStub) {
          node.innerComments = null;
        }
      },
    });
    if (ast.comments) {
      ast.comments = ast.comments.filter(() => false);
    }
  }

  const output = generate(ast, {
    comments: true, // remaining comments are only stub placeholders or kept comments
    compact: level === 'ultra-slim',
    retainLines: false,
    jsescOption: { minimal: true },
  });

  return output.code.trim();
}
