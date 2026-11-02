// PreToolUse hook on Bash: blocks package runners that would download a package nobody approved.
// npx, npm exec / npm x and bunx run a local tool when it is installed and download it otherwise;
// pnpm dlx, pnpx and yarn dlx always download. Exit 2 blocks the command and shows the message to
// Claude; exit 0 lets it run. Any error while checking blocks too (fail closed).
import fs from 'node:fs';
import path from 'node:path';

// A command mentioning a runner but long enough to risk pathological regex backtracking is blocked
// outright rather than scanned.
const MAX_RUNNER_COMMAND_LENGTH = 2000;

// Only calls in command position (start of a line, or after ; & | or a parenthesis) count, so text that
// merely mentions a runner (an echo, a commit message) is not blocked. Env assignments and the env, command,
// exec, time, sudo, nohup and nice wrappers may come before the runner.
const CD_CALL = /(?:^|[;&|(\n])\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const INSTALL_FLAGS = /^(-y|--yes|-p|--package)(=|$)/;
// A wrapper flag may take its own value as a separate token (`nice -n 10`, `sudo -u alice`), so one
// optional non-dash value token is allowed after each dash-flag.
const WRAPPER_PREFIX = '(?:env|command|exec|time|sudo|nohup|nice)';
const RUNNER_NAMES = '(npx|bunx|npm\\s+(?:exec|x)|pnpx|pnpm\\s+dlx|yarn\\s+dlx)';
const RUNNER_CALL = new RegExp(
  `(?:^|[;&|(\\n])\\s*(?:${WRAPPER_PREFIX}(?:\\s+-[^\\s;&|)]+(?:\\s+[^\\s;&|)-][^\\s;&|)]*)?)*\\s+|[A-Za-z_]\\w*=[^\\s;&|)]*\\s+)*${RUNNER_NAMES}((?:\\s+(?:--?(?=[\\s;&|)]|$)|--?[^\\s;&|)-][^\\s;&|)]*))*)\\s+([^\\s;&|)-][^\\s;&|)]*)`,
  'g',
);
// Looser version of the same command-position prefix, used only to detect a runner name the stricter
// RUNNER_CALL above failed to fully parse (unusual flags, an unhandled wrapper shape) — never to decide
// anything about the call itself. Any wrapper-token shape counts here, not just dash-flags.
const RUNNER_IN_POSITION = new RegExp(
  `(?:^|[;&|(\\n])\\s*(?:${WRAPPER_PREFIX}(?:\\s+[^\\s;&|)]+)*\\s+|[A-Za-z_]\\w*=[^\\s;&|)]*\\s+)*${RUNNER_NAMES}\\b`,
  'g',
);
const ALWAYS_DOWNLOADS = /^(pnpx|pnpm\s+dlx|yarn\s+dlx)$/;
// npm's package-name syntax. Anything else (a path, a URL, a git spec, a quote or escape the shell would strip)
// could point the installed check at the wrong file.
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// Quotes, escapes and expansions the shell would rewrite, so the guard cannot read the flag as the runner will.
const SHELL_QUOTING = /["'\\$`]/;
// "tsx@5" or "@scope/name@1.2": a version or tag the local install may not have, so the runner may download it.
const VERSIONED = /^(@[^/]+\/)?[^@]+@/;
// A runner name can also reach the shell through a construct this guard cannot parse into positions:
// command substitution, a backtick, `eval`, `xargs`, or handing the string to another shell with -c.
const OPAQUE_SHELL = /`|\$\(|\b(?:eval|xargs|bash\s+-c|sh\s+-c|zsh\s+-c)\b/;
const RUNNER_NAME = /\b(?:npx|bunx|pnpx|npm\s+(?:exec|x)|pnpm\s+dlx|yarn\s+dlx)\b/;
// pushd/popd move the shell's working directory without producing a `cd` this guard tracks; `cd -`,
// a bare `cd` (jumps to $HOME) and a target built from command substitution can't be resolved either.
// Any of these makes the folder a later runner call actually runs in unverifiable.
const PUSHD_POPD = /(?:^|[;&|(\n])\s*(?:pushd|popd)\b/;
const CD_DASH = /(?:^|[;&|(\n])\s*cd\s+-(?:\s|$)/;
const CD_NO_ARG = /(?:^|[;&|(\n])\s*cd\s*(?:[;&|)\n]|$)/;
const CD_EXPANSION = /(?:^|[;&|(\n])\s*cd\s+[^\s;&|)]*[`$][^\s;&|)]*/;

const LABELS = {
  alwaysDownloads: (call) => `Blocked: "${call}" always downloads a package. Ask Adrianus before installing anything.`,
  error: (reason) => `Blocked: the npx guard could not check this command (${reason}).`,
  invalidName: (spec) => `Blocked: "${spec}" is not a plain package name, so the guard cannot tell whether the runner would download it. Ask Adrianus.`,
  installFlag: (call) => `Blocked: "${call}" asks the runner to install a package. Ask Adrianus before installing anything.`,
  notInstalled: (tool, folder) =>
    `Blocked: "${tool}" is not installed in ${folder} or any folder above it, so the runner would download it. Use node_modules/.bin/<tool> from the project, or ask Adrianus before installing anything.`,
  opaque: () => `Blocked: this command hides a package runner behind eval/backticks/$()/xargs or another shell, which the guard cannot fully parse. Ask Adrianus before installing anything.`,
  quotedFlag: (call) => `Blocked: "${call}" quotes or escapes a flag, so the guard cannot check it. Write the flags plainly.`,
  tooLong: (length) => `Blocked: this command is ${length} characters long and mentions a package runner, too long for the guard to check safely. Ask Adrianus.`,
  unparsed: (call) => `Blocked: "${call}" invokes a package runner in a shape the guard cannot fully parse (unusual flags or wrapper options). Ask Adrianus before installing anything.`,
  unresolvableCd: () => `Blocked: this command changes directory in a way the guard cannot resolve (pushd/popd, "cd -", a bare cd, or a computed path), so it cannot verify where a package runner would run. Ask Adrianus before installing anything.`,
  versioned: (spec) => `Blocked: "${spec}" names a version, which the runner may download. Use node_modules/.bin/<tool> from the project, or ask Adrianus.`,
};

const block = (message) => {
  console.error(message);
  process.exit(2);
};

// "@scope/name" → "name"; "tsx" → "tsx".
const binNameOf = (spec) => spec.replace(/^@[^/]+\//, '');

const hasUnresolvableCdBefore = (text) =>
  PUSHD_POPD.test(text) || CD_DASH.test(text) || CD_NO_ARG.test(text) || CD_EXPANSION.test(text);

function check(input) {
  const command = input.tool_input?.command ?? '';
  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (RUNNER_NAME.test(command) && command.length > MAX_RUNNER_COMMAND_LENGTH) block(LABELS.tooLong(command.length));
  if (OPAQUE_SHELL.test(command) && RUNNER_NAME.test(command)) block(LABELS.opaque());

  // The folder the runner runs in: fold every `cd` before it in order, each resolved against where the
  // previous one landed (not always the session's folder) — "cd a && cd .." must land back at the start.
  const folderAt = (index) => {
    if (hasUnresolvableCdBefore(command.slice(0, index))) block(LABELS.unresolvableCd());

    let current = startDir;
    for (const match of command.matchAll(CD_CALL)) {
      if (match.index >= index) break;

      const target = match[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
      current = path.resolve(current, target);
    }

    return current;
  };

  // Like npx: look for node_modules/.bin/<name> in the folder and every folder above it. For a scoped
  // spec, also require node_modules/<@scope/name> itself to be present there — scoped packages are
  // always installed under their own full name, so an unrelated package cannot satisfy the check just
  // by installing a bin of the same short name. An unscoped package's directory name doesn't always
  // match its bin name (e.g. "typescript" provides "tsc"), so that extra check only applies when scoped.
  const isInstalled = (folder, spec) => {
    const name = binNameOf(spec);
    const scopedPackage = spec.startsWith('@') ? spec : null;
    for (let current = folder; ; current = path.dirname(current)) {
      const nodeModules = path.join(current, 'node_modules');
      const binFound = fs.existsSync(path.join(nodeModules, '.bin', name));
      const packageFound = !scopedPackage || fs.existsSync(path.join(nodeModules, scopedPackage));
      if (binFound && packageFound) return true;
      if (current === path.dirname(current)) return false;
    }
  };

  // Fail closed on any runner name in command position that RUNNER_CALL's stricter shape didn't
  // capture at that exact spot — an unparseable call is treated as a bypass attempt, not let through.
  const parsedStarts = new Set([...command.matchAll(RUNNER_CALL)].map((match) => match.index));
  for (const match of command.matchAll(RUNNER_IN_POSITION)) {
    if (!parsedStarts.has(match.index)) block(LABELS.unparsed(match[0].trim()));
  }

  for (const match of command.matchAll(RUNNER_CALL)) {
    const [call, runner, flags, spec] = match;
    if (ALWAYS_DOWNLOADS.test(runner)) block(LABELS.alwaysDownloads(call.trim()));
    if (SHELL_QUOTING.test(flags)) block(LABELS.quotedFlag(call.trim()));
    if (flags.trim().split(/\s+/).some((flag) => INSTALL_FLAGS.test(flag))) block(LABELS.installFlag(call.trim()));
    if (VERSIONED.test(spec)) block(LABELS.versioned(spec));
    if (!PACKAGE_NAME.test(spec)) block(LABELS.invalidName(spec));

    const folder = folderAt(match.index);
    if (!isInstalled(folder, spec)) block(LABELS.notInstalled(spec, folder));
  }
}

try {
  check(JSON.parse(fs.readFileSync(0, 'utf8')));
} catch (error) {
  block(LABELS.error(error instanceof Error ? error.message : String(error)));
}
