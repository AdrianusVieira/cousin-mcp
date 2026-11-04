// Source: roggenhub/.claude/hooks/npx-guard.mjs. Edit only there; roggenhub/scripts/sync-npx-guard.mjs copies it
// to the other repositories.
// PreToolUse hook on Bash: blocks package runners that would download a package nobody approved.
// npx, npm exec / npm x and bunx run a local tool when it is installed and download it otherwise;
// pnpm dlx, pnpx and yarn dlx always download. Exit 2 blocks the command and shows the message to
// Claude; exit 0 lets it run. Any error while checking blocks too (fail closed).
import fs from 'node:fs';
import path from 'node:path';

// Only calls in command position (start of a line, or after ; & | or a parenthesis) count, so text that
// merely mentions a runner (an echo, a commit message) is not blocked. Env assignments and the env, command,
// exec, nice, nohup, sudo and time wrappers may come before the runner, and a wrapper or runner may be called by
// its path (/usr/local/bin/npx).
const CD_STEP = /(?:^|[;&|(\n])\s*(cd|pushd|popd)(?=[\s;&|)]|$)([^;&|)\n]*)/g;
// A cd target the guard can follow: one quoted or bare word, with no expansion and no flag.
const CD_TARGET = /^(?:"([^"$`]*)"|'([^']*)'|([^\s"'$`-][^\s"'$`]*))$/;
// npm accepts any unambiguous prefix of a long flag (--pack=x is --package=x) and bundles short ones (-yq).
const INSTALL_FLAG_NAMES = ['package', 'yes'];
const INSTALL_SHORT_FLAG = /^-[^-]*[py]/;
// Commands longer than this that mention a runner are blocked unread, so no regex scans an unbounded input.
const MAX_RUNNER_COMMAND_LENGTH = 2000;
// Backticks, $(), eval, xargs and bash/sh/zsh -c run text the position-based match cannot see into.
const OPAQUE_SHELL = /`|\$\(|\beval\b|\bxargs\b|\b(?:bash|sh|zsh)\s+-[A-Za-z]*c/;
// A flag written plainly. Quotes, escapes, expansions, braces and globs the shell would rewrite are not, so the
// guard cannot read them as the runner will.
const PLAIN_FLAG = /^(--|--?[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/@:~-]*)?)$/;
const RUNNER_CALL =
  /(?:^|[;&|(\n])\s*(?:(?:[^\s;&|)]*\/)?(?:env|command|exec|nice|nohup|sudo|time)(?:\s+-[^\s;&|)]+)*\s+|[A-Za-z_]\w*=[^\s;&|)]*\s+)*(?:[^\s;&|)]*\/)?(npx|bunx|npm\s+(?:exec|x)|pnpx|pnpm\s+dlx|yarn\s+dlx)((?:\s+(?:--|--?[^\s;&|)-][^\s;&|)]*))*)\s+([^\s;&|)-][^\s;&|)]*)/g;
// A runner name standing alone or ending a path, so a file like npx-guard.mjs or a path like bin/npx.d is not a
// mention, and /usr/local/bin/npx is.
const RUNNER_MENTION = /(?<![\w.-])(?:npx|bunx|pnpx|npm\s+(?:exec|x)|pnpm\s+dlx|yarn\s+dlx)(?![\w./-])/;
// A segment between separators, and the words that make it a runner call: a runner or a wrapper, after any
// env assignments.
// The separator comes first so a leading "(" opens its own segment instead of an empty one at ^.
const SEGMENT = /(?:[;&|(\n]|^)[^;&|(\n]*/g;
const SEGMENT_START = /^\s*(?:[A-Za-z_]\w*=[^\s;&|)]*\s+)*(?:[^\s;&|)]*\/)?(?:env|command|exec|nice|nohup|sudo|time|npx|bunx|pnpx|npm|pnpm|yarn)\b/;
const ALWAYS_DOWNLOADS = /^(pnpx|pnpm\s+dlx|yarn\s+dlx)$/;
// npm's package-name syntax. Anything else (a path, a URL, a git spec, a quote or escape the shell would strip)
// could point the installed check at the wrong file.
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// "tsx@5" or "@scope/name@1.2": a version or tag the local install may not have, so the runner may download it.
const VERSIONED = /^(@[^/]+\/)?[^@]+@/;

const LABELS = {
  alwaysDownloads: (call) => `Blocked: "${call}" always downloads a package. Ask Adrianus before installing anything.`,
  error: (reason) => `Blocked: the npx guard could not check this command (${reason}).`,
  installFlag: (call) => `Blocked: "${call}" asks the runner to install a package. Ask Adrianus before installing anything.`,
  invalidName: (spec) => `Blocked: "${spec}" is not a plain package name, so the guard cannot tell whether the runner would download it. Ask Adrianus.`,
  notInstalled: (tool, folder) =>
    `Blocked: "${tool}" is not installed in ${folder} or any folder above it, so the runner would download it. Use node_modules/.bin/<tool> from the project, or ask Adrianus before installing anything.`,
  opaqueShell: () =>
    'Blocked: this command mentions a package runner inside backticks, $(), eval, xargs or a shell -c, which the guard cannot check. Run the tool directly.',
  tooLong: (length) =>
    `Blocked: this command mentions a package runner and is ${length} characters long, over the guard's ${MAX_RUNNER_COMMAND_LENGTH}-character limit. Split it up.`,
  unplainFlag: (call) => `Blocked: "${call}" has a flag the shell would rewrite, so the guard cannot check it. Write the flags plainly.`,
  unreadableCall: (segment) => `Blocked: "${segment}" runs a package runner the guard cannot read. Write it as <runner> <flags> <package>.`,
  untrackedCd: (call) =>
    `Blocked: "${call}" runs after a directory change the guard cannot follow (pushd/popd, cd -, a bare cd, a cd flag or expansion, or a subshell). Use cd with a plain path.`,
  versioned: (spec) => `Blocked: "${spec}" names a version, which the runner may download. Use node_modules/.bin/<tool> from the project, or ask Adrianus.`,
};

const block = (message) => {
  console.error(message);
  process.exit(2);
};

const isInstallFlag = (flag) => {
  if (INSTALL_SHORT_FLAG.test(flag)) return true;

  const name = flag.match(/^--([^=]+)/)?.[1];

  return Boolean(name) && INSTALL_FLAG_NAMES.some((full) => full.startsWith(name));
};

// "@scope/name" → "name"; "tsx" → "tsx".
const binNameOf = (spec) => spec.replace(/^@[^/]+\//, '');

function check(input) {
  const command = input.tool_input?.command ?? '';
  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (!RUNNER_MENTION.test(command)) return;
  if (command.length > MAX_RUNNER_COMMAND_LENGTH) block(LABELS.tooLong(command.length));
  if (OPAQUE_SHELL.test(command)) block(LABELS.opaqueShell());

  // The folder the runner runs in: every `cd` before it, in order, each resolved from where the previous one
  // landed. null when one of them cannot be followed.
  const folderAt = (index) => {
    let folder = startDir;
    for (const step of command.matchAll(CD_STEP)) {
      if (step.index >= index) break;

      const [, verb, args] = step;
      const target = args.trim().match(CD_TARGET);
      // A ) between the cd and the runner closes a subshell, so the runner may not run where the cd went.
      if (verb !== 'cd' || !target || command.slice(step.index, index).includes(')')) return null;

      const word = target[1] ?? target[2] ?? target[3];
      if (/^~[^/]/.test(word)) return null;

      folder = path.resolve(folder, word.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    }

    return folder;
  };

  // Like npx: look for node_modules/.bin/<name> in the folder and every folder above it. A scoped spec must
  // also have its own package at that level, so another package's bin of the same name does not count.
  const isInstalled = (folder, spec) => {
    for (let current = folder; ; current = path.dirname(current)) {
      const modules = path.join(current, 'node_modules');
      const hasBin = fs.existsSync(path.join(modules, '.bin', binNameOf(spec)));
      if (hasBin && (!spec.startsWith('@') || fs.existsSync(path.join(modules, spec)))) return true;
      if (current === path.dirname(current)) return false;
    }
  };

  const parsedAt = new Set();
  for (const match of command.matchAll(RUNNER_CALL)) {
    const [call, runner, flags, spec] = match;
    parsedAt.add(match.index);
    if (ALWAYS_DOWNLOADS.test(runner)) block(LABELS.alwaysDownloads(call.trim()));
    const flagList = flags.trim().split(/\s+/).filter(Boolean);
    if (!flagList.every((flag) => PLAIN_FLAG.test(flag))) block(LABELS.unplainFlag(call.trim()));
    if (flagList.some(isInstallFlag)) block(LABELS.installFlag(call.trim()));
    if (VERSIONED.test(spec)) block(LABELS.versioned(spec));
    if (!PACKAGE_NAME.test(spec)) block(LABELS.invalidName(spec));

    const folder = folderAt(match.index);
    if (folder === null) block(LABELS.untrackedCd(call.trim()));
    if (!isInstalled(folder, spec)) block(LABELS.notInstalled(spec, folder));
  }

  // A runner call the pattern above could not read (a wrapper flag with a value, an odd flag) is blocked, not
  // let through unchecked.
  for (const segment of command.matchAll(SEGMENT)) {
    const body = segment[0].replace(/^[;&|(\n]/, '');
    if (SEGMENT_START.test(body) && RUNNER_MENTION.test(body) && !parsedAt.has(segment.index)) {
      block(LABELS.unreadableCall(body.trim()));
    }
  }
}

try {
  check(JSON.parse(fs.readFileSync(0, 'utf8')));
} catch (error) {
  block(LABELS.error(error instanceof Error ? error.message : String(error)));
}
