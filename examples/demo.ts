/**
 * ContextDiet demo file — open this in VS Code after installing the extension
 * and try the commands on it. Every compression trick has a target here:
 *  - this JSDoc block and the inline comments  -> removed at Diet
 *  - the console.log / console.debug calls     -> removed at Diet
 *  - the unused `readFileSync` import          -> removed at Skeleton
 *  - `slugify` (internal, non-exported)        -> body stubbed at Skeleton
 *  - `keepThisLogic` (@diet-keep)              -> body preserved at every level
 *  - the `BlogPost` interface                  -> flattened to one line at Ultra-Slim
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface BlogPost {
  id: number;
  title: string;
  filePath: string;
  tags: string[];
  published: boolean;
}

// Internal helper: only used by buildPost below, never exported.
function slugify(title: string): string {
  console.log("slugifying:", title);
  const lowered = title.toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  console.debug("slug result:", trimmed);
  return trimmed;
}

// @diet-keep
export function keepThisLogic(seed: number): number {
  // This body survives even Skeleton and Ultra-Slim because of the directive.
  let value = seed;
  for (let i = 0; i < 5; i++) {
    value = value * 3 + 1;
  }
  return value;
}

export function buildPost(title: string, filePath: string): BlogPost {
  console.log("building post:", title);
  const post: BlogPost = {
    id: keepThisLogic(title.length),
    title,
    filePath: basename(filePath),
    tags: [slugify(title)],
    published: false,
  };
  return post;
}
