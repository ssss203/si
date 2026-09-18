import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(toolsDirectory, '..');
const buildDirectory = path.join(root, '.build', 'asset-tools');
const visionSource = path.join(toolsDirectory, 'vision-cutout.swift');
const pinnedRembg = 'rembg[cpu,cli]==2.0.76';
const commandTimeoutMs = Number(process.env.PET_CUTOUT_TIMEOUT_MS || 300_000);
let temporaryRembgPromise;
let temporaryRembgDirectory;
let visionBinaryPromise;
let routeAnnounced = false;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function run(command, args, environment = {}, timeoutMs = commandTimeoutMs) {
  let child;
  try {
    child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw codedError('CUTOUT_COMMAND_UNAVAILABLE', `${command} could not be started`, error);
  }

  const stdout = [];
  const stderr = [];
  child.stdout?.on('data', (chunk) => stdout.push(chunk));
  child.stderr?.on('data', (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  timer.unref();

  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  }).catch((error) => {
    throw codedError('CUTOUT_COMMAND_UNAVAILABLE', `${command} is unavailable: ${error.message}`, error);
  }).finally(() => clearTimeout(timer));

  const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
  const stderrText = Buffer.concat(stderr).toString('utf8').trim();
  if (timedOut) {
    throw codedError(
      'CUTOUT_COMMAND_TIMEOUT',
      `${path.basename(command)} exceeded the ${Math.round(timeoutMs / 1000)} second cutout timeout`,
    );
  }
  if (result !== 0) {
    throw codedError(
      'CUTOUT_COMMAND_FAILED',
      `${path.basename(command)} failed: ${stderrText || stdoutText || `exit code ${result}`}`,
    );
  }
  return stdoutText;
}

function cleanupTemporaryRembg() {
  if (!temporaryRembgDirectory) return;
  rmSync(temporaryRembgDirectory, { recursive: true, force: true });
  temporaryRembgDirectory = undefined;
}

process.once('exit', cleanupTemporaryRembg);

async function firstWindowsPython() {
  const candidates = [
    process.env.PET_PYTHON ? { command: process.env.PET_PYTHON, prefix: [] } : undefined,
    { command: 'py', prefix: ['-3.11'] },
    { command: 'py', prefix: ['-3'] },
    { command: 'python', prefix: [] },
    { command: 'python3', prefix: [] },
  ].filter(Boolean);
  const attempts = [];
  for (const candidate of candidates) {
    try {
      await run(candidate.command, [...candidate.prefix, '--version'], {}, 15_000);
      return candidate;
    } catch (error) {
      attempts.push(`${candidate.command} ${candidate.prefix.join(' ')}: ${error.message}`);
    }
  }
  throw codedError(
    'SEGMENTATION_BACKEND_UNAVAILABLE',
    `Windows rembg requires Python 3, but no usable interpreter was found: ${attempts.join(' | ')}`,
  );
}

async function temporaryWindowsRembg() {
  temporaryRembgPromise ??= (async () => {
    const candidate = await firstWindowsPython();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pet-rembg-'));
    const venv = path.join(directory, 'venv');
    const python = path.join(venv, 'Scripts', 'python.exe');
    const rembg = path.join(venv, 'Scripts', 'rembg.exe');
    try {
      await run(candidate.command, [...candidate.prefix, '-m', 'venv', venv], {}, 120_000);
      await run(
        python,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', pinnedRembg],
        {},
        commandTimeoutMs,
      );
      await access(rembg);
      // WDAC/AppLocker on this host blocks numba's _nrt_python DLL.
      // pymatting imports numba at package load time; rembg imports pymatting
      // names at module top-level. Replace pymatting with lazy stubs so rembg
      // loads without numba. These functions are only called with -a (alpha
      // matting), which this build never uses.
      const sitePackages = path.join(venv, 'Lib', 'site-packages');
      const pymattingDir = path.join(sitePackages, 'pymatting');
      try {
        await rm(pymattingDir, { recursive: true, force: true });
        const stubContent = [
          '"""Stub pymatting module: numba is blocked by WDAC on this host."""',
          '',
          'def __getattr__(name):',
          '    def _stub(*args, **kwargs):',
          '        raise RuntimeError(',
          '            f"pymatting.{name} is disabled: alpha matting is not used by this build"',
          '        )',
          '    return _stub',
          '',
        ].join('\n');
        const stubFiles = [
          path.join(pymattingDir, '__init__.py'),
          path.join(pymattingDir, 'alpha', '__init__.py'),
          path.join(pymattingDir, 'alpha', 'estimate_alpha_cf.py'),
          path.join(pymattingDir, 'foreground', '__init__.py'),
          path.join(pymattingDir, 'foreground', 'estimate_foreground_ml.py'),
          path.join(pymattingDir, 'util', '__init__.py'),
          path.join(pymattingDir, 'util', 'util.py'),
        ];
        for (const file of stubFiles) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, stubContent, 'utf8');
        }
      } catch {
        // Non-fatal: if stubbing fails, rembg may still work on hosts without WDAC.
      }
      // Seed the per-run models dir from the persistent build cache so rembg
      // does not re-download model weights on every run.
      const modelsDir = path.join(directory, 'models');
      const cachedModelsDir = path.join(buildDirectory, 'models');
      try {
        await mkdir(modelsDir, { recursive: true });
        const { readdir } = await import('node:fs/promises');
        for (const file of await readdir(cachedModelsDir)) {
          await copyFile(path.join(cachedModelsDir, file), path.join(modelsDir, file));
        }
      } catch {
        // Non-fatal: model will be downloaded by rembg if the cache is missing.
      }
      temporaryRembgDirectory = directory;
      return {
        command: rembg,
        environment: { U2NET_HOME: modelsDir },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw codedError(
        'SEGMENTATION_BACKEND_UNAVAILABLE',
        `Controlled Windows rembg setup failed once via ${candidate.command}; it will not retry or install globally: ${error.message}`,
        error,
      );
    }
  })();
  return temporaryRembgPromise;
}

async function visionBinary() {
  visionBinaryPromise ??= (async () => {
    const version = await run('sw_vers', ['-productVersion'], {}, 15_000).catch((error) => {
      throw codedError(
        'SEGMENTATION_BACKEND_UNAVAILABLE',
        `Cannot determine the macOS version required by Apple Vision: ${error.message}`,
        error,
      );
    });
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || major < 14) {
      throw codedError(
        'SEGMENTATION_BACKEND_UNAVAILABLE',
        `Apple Vision foreground cutout requires macOS 14 or later; current version is ${version || 'unknown'}`,
      );
    }

    const source = await readFile(visionSource);
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const binary = path.join(buildDirectory, `vision-cutout-${digest}`);
    try {
      await access(binary);
      return binary;
    } catch {
      await mkdir(buildDirectory, { recursive: true });
    }
    try {
      await run('xcrun', ['swiftc', visionSource, '-O', '-o', binary], {}, 180_000);
      return binary;
    } catch (error) {
      throw codedError(
        'SEGMENTATION_BACKEND_UNAVAILABLE',
        `Apple Vision could not compile with xcrun swiftc; install or repair Xcode Command Line Tools. No rembg fallback will run on macOS. ${error.message}`,
        error,
      );
    }
  })();
  return visionBinaryPromise;
}

async function appleVisionCutout(input, output) {
  const binary = await visionBinary();
  await mkdir(path.dirname(output), { recursive: true });
  await run(binary, [input, output]);
  return 'apple-vision';
}

function rembgModel(subjectKind) {
  if (subjectKind === 'illustration') return 'isnet-anime';
  if (subjectKind === 'photo') return 'birefnet-general';
  return 'isnet-general-use';
}

async function windowsRembgCutout(input, output, subjectKind) {
  const { command, environment } = await temporaryWindowsRembg();
  await mkdir(path.dirname(output), { recursive: true });
  const model = rembgModel(subjectKind);
  await run(command, ['i', '-m', model, input, output], environment);
  return `rembg:${model}`;
}

function platformBackend() {
  if (process.platform === 'darwin') return 'apple-vision';
  if (process.platform === 'win32') return 'rembg';
  return undefined;
}

export async function semanticCutout({
  input,
  output,
  backend = 'auto',
  subjectKind = 'auto',
}) {
  const selected = platformBackend();
  if (!selected) {
    throw codedError(
      'SEGMENTATION_BACKEND_UNAVAILABLE',
      `Semantic cutout supports macOS (Apple Vision) and Windows (temporary rembg), not ${process.platform}`,
    );
  }
  if (backend !== 'auto' && backend !== selected) {
    throw codedError(
      'SEGMENTATION_BACKEND_UNAVAILABLE',
      `Configured backend ${backend} conflicts with ${process.platform}; this lean route requires ${selected} and will not fall back`,
    );
  }

  if (!routeAnnounced) {
    console.log(
      `Semantic cutout route: ${process.platform === 'darwin'
        ? 'macOS -> Apple Vision only (no rembg fallback)'
        : 'Windows -> controlled temporary rembg only'}`,
    );
    routeAnnounced = true;
  }

  const result = selected === 'apple-vision'
    ? await appleVisionCutout(input, output)
    : await windowsRembgCutout(input, output, subjectKind);
  return { backend: result, attempts: [] };
}
