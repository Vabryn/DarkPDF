/** Writes version.json into the deployed asset directory so the live site can
 * be matched to a commit. Run from the deploy script, before wrangler.
 *
 * The output directory is the first argument, and defaults to the repo root.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const out = join(process.argv[2] || '.', 'version.json');
const version = {
  commit: git('rev-parse', '--short', 'HEAD'),
  subject: git('log', '-1', '--format=%s'),
  committed: git('log', '-1', '--format=%cI'),
  deployed: new Date().toISOString(),
  // False when tracked files were modified but not committed, which means the
  // deployed site matches no commit.
  clean: git('status', '--porcelain') === ''
};

writeFileSync(out, JSON.stringify(version, null, 2) + '\n');
console.log(`${out} -> ${version.commit}${version.clean ? '' : '  (uncommitted changes)'}`);
