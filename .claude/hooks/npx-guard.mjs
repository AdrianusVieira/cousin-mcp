// PreToolUse hook on Bash: blocks package runners that would download a package nobody approved.
// npx, npm exec / npm x and bunx run a local tool when it is installed and download it otherwise;
// pnpm dlx, pnpx and yarn dlx always download. Exit 2 blocks the command and shows the message to
// Claude; exit 0 lets it run. Any error while checking blocks too (fail closed).
import fs from 'node:fs';
import path from 'node:path';

// Only calls in command position (start of a line, or after ; & | or a parenthesis) count, so text that
// merely mentions a runner (an echo, a commit message) is not blocked. Env assignments and the env, command,
// exec and time wrappers may come before the runner.
const CD_CALL = /(?:^|[;&|(\n])\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
const INSTALL_FLAGS = /^(-y|--yes|-p|--package)(=|$)/;
const RUNNER_CALL =
  /(?:^|[;&|(\n])\s*(?:(?:env|command|exec|time)(?:\s+-[^\s;&|)]+)*\s+|[A-Za-z_]\w*=[^\s;&|)]*\s+)*(npx|bunx|npm\s+(?:exec|x)|pnpx|pnpm\s+dlx|yarn\s+dlx)((?:\s+-{1,2}[^\s;&|)]*)*)\s+([^\s;&|)-][^\s;&|)]*)/g;
const ALWAYS_DOWNLOADS = /^(pnpx|pnpm\s+dlx|yarn\s+dlx)$/;
// npm's package-name syntax. Anything else (a path, a URL, a git spec, a quote or escape the shell would strip)
// could point the installed check at the wrong file.
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
// Quotes, escapes and expansions the shell would rewrite, so the guard cannot read the flag as the runner will.
const SHELL_QUOTING = /["'\\$`]/;
// "tsx@5" or "@scope/name@1.2": a version or tag the local install may not have, so the runner may download it.
const VERSIONED = /^(@[^/]+\/)?[^@]+@/;

const LABELS = {
  alwaysDownloads: (call) => `Blocked: "${call}" always downloads a package. Ask Adrianus before installing anything.`,
  error: (reason) => `Blocked: the npx guard could not check this command (${reason}).`,
  invalidName: (spec) => `Blocked: "${spec}" is not a plain package name, so the guard cannot tell whether the runner would download it. Ask Adrianus.`,
  installFlag: (call) => `Blocked: "${call}" asks the runner to install a package. Ask Adrianus before installing anything.`,
  notInstalled: (tool, folder) =>
    `Blocked: "${tool}" is not installed in ${folder} or any folder above it, so the runner would download it. Use node_modules/.bin/<tool> from the project, or ask Adrianus before installing anything.`,
  quotedFlag: (call) => `Blocked: "${call}" quotes or escapes a flag, so the guard cannot check it. Write the flags plainly.`,
  versioned: (spec) => `Blocked: "${spec}" names a version, which the runner may download. Use node_modules/.bin/<tool> from the project, or ask Adrianus.`,
};

const block = (message) => {
  console.error(message);
  process.exit(2);
};

// "@scope/name" → "name"; "tsx" → "tsx".
const binNameOf = (spec) => spec.replace(/^@[^/]+\//, '');

function check(input) {
  const command = input.tool_input?.command ?? '';
  const startDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // The folder the runner runs in: the last `cd` before it in the command, if any, else the session's folder.
  const folderAt = (index) => {
    const lastCd = [...command.matchAll(CD_CALL)].filter((match) => match.index < index).at(-1);
    if (!lastCd) return startDir;

    const target = lastCd[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

    return path.resolve(startDir, target);
  };

  // Like npx: look for node_modules/.bin/<name> in the folder and every folder above it.
  const isInstalled = (folder, name) => {
    for (let current = folder; ; current = path.dirname(current)) {
      if (fs.existsSync(path.join(current, 'node_modules', '.bin', name))) return true;
      if (current === path.dirname(current)) return false;
    }
  };

  for (const match of command.matchAll(RUNNER_CALL)) {
    const [call, runner, flags, spec] = match;
    if (ALWAYS_DOWNLOADS.test(runner)) block(LABELS.alwaysDownloads(call.trim()));
    if (SHELL_QUOTING.test(flags)) block(LABELS.quotedFlag(call.trim()));
    if (flags.trim().split(/\s+/).some((flag) => INSTALL_FLAGS.test(flag))) block(LABELS.installFlag(call.trim()));
    if (VERSIONED.test(spec)) block(LABELS.versioned(spec));
    if (!PACKAGE_NAME.test(spec)) block(LABELS.invalidName(spec));

    const folder = folderAt(match.index);
    if (!isInstalled(folder, binNameOf(spec))) block(LABELS.notInstalled(spec, folder));
  }
}

try {
  check(JSON.parse(fs.readFileSync(0, 'utf8')));
} catch (error) {
  block(LABELS.error(error instanceof Error ? error.message : String(error)));
}
