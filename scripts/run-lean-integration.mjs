import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.LEAN_TEST_BINARY) {
  console.error('Set LEAN_TEST_BINARY to the absolute path of an installed Lean executable. See docs/verification.md.');
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^real (Lean|Lake) ',
  'test/prove2me.test.mjs', 'test/sketch.test.mjs', 'test/isolation.test.mjs', 'test/compiled-dependencies.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  const checks = output.match(/^ok \d+ - real (?:Lean|Lake) .+$/gm) ?? [];
  if (code !== 0 || checks.length !== 6 || checks.some(line => /# (?:SKIP|TODO)/i.test(line))) {
    console.error(`Lean integration requires six passing, unskipped compiler checks; observed ${checks.length}.`);
    process.exitCode = 1;
  }
});
