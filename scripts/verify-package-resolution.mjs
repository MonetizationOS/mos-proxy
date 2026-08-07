#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packageName = '@monetizationos/proxy'

// Under `npm publish --dry-run` this script inherits npm_config_dry_run, which makes `pnpm pack` report a path it never writes.
delete process.env.npm_config_dry_run
const binary = (name) => join(repoRoot, 'node_modules', '.bin', name)

const expectedRuntimeExports = [
    'ConfigUnresolvableError',
    'MOSProxy',
    'MOSProxyBuilder',
    'buildIdentity',
    'defaultPersistIdentity',
    'defaultResolveIdentity',
    'getExistingCookies',
    'hostPathMatcher',
]

const run = (command, args, cwd, { showOutput = false } = {}) => {
    try {
        return execFileSync(command, args, {
            cwd,
            encoding: 'utf8',
            stdio: showOutput ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'inherit'],
        })
    } catch (error) {
        throw new Error(`${command} ${args.join(' ')} exited with ${error.status}\n${error.stdout ?? ''}`.trim())
    }
}

const step = (message) => console.log(`\n=== ${message}`)

const relativeSpecifier = /\b(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g
const runtimeExtension = /\.(?:js|mjs|cjs|json)$/

const emittedFiles = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
            return emittedFiles(path)
        }
        return /\.(?:js|mjs|cjs|d\.ts)$/.test(entry.name) ? [path] : []
    })

const specifiersNodeCannotResolve = (distDir) =>
    emittedFiles(distDir).flatMap((path) => {
        const contents = readFileSync(path, 'utf8')
        return [...contents.matchAll(relativeSpecifier)]
            .map((match) => match[2])
            .filter((specifier) => !runtimeExtension.test(specifier))
            .map((specifier) => `${relative(distDir, path)}: ${specifier}`)
    })

const workDir = mkdtempSync(join(tmpdir(), 'mos-proxy-resolution-'))
const consumerDir = join(workDir, 'consumer')
mkdirSync(consumerDir)

const failures = []

// Each check runs even when an earlier one failed, so one run reports every way the package fails to resolve.
const runCheck = (message, body) => {
    step(message)
    try {
        body()
    } catch (error) {
        failures.push(`${message}\n${error.message}`)
        console.log(`FAILED: ${error.message}`)
    }
}

try {
    // `prepack` builds, so packing here exercises the same path that produces the published tarball.
    step('Packing the tarball')
    run('pnpm', ['pack', '--pack-destination', workDir], repoRoot)
    const tarball = readdirSync(workDir).find((entry) => entry.endsWith('.tgz'))
    if (!tarball) {
        throw new Error(`pnpm pack produced no tarball in ${workDir}`)
    }

    step('Installing the tarball into a scratch consumer')
    writeFileSync(
        join(consumerDir, 'package.json'),
        `${JSON.stringify({ name: 'mos-proxy-resolution-consumer', private: true, type: 'module' }, null, 2)}\n`,
    )
    // npm rather than pnpm because pnpm's symlinked store tests a layout this package is not published for.
    run('npm', ['install', join(workDir, tarball), '--no-audit', '--no-fund', '--loglevel=error'], consumerDir)

    // The only check that covers a module no consumer import reaches, and the emitted form rather than one entry point.
    runCheck('Scanning the installed dist for relative specifiers Node cannot resolve', () => {
        const distDir = join(consumerDir, 'node_modules', ...packageName.split('/'), 'dist')
        const unresolvable = specifiersNodeCannotResolve(distDir)
        if (unresolvable.length > 0) {
            throw new Error(`Relative specifiers without a runtime extension:\n${unresolvable.join('\n')}`)
        }
        console.log(`Scanned ${emittedFiles(distDir).length} emitted files, every relative specifier carries a runtime extension`)
    })

    runCheck(`Importing ${packageName} from plain Node ${process.version}`, () => {
        const importedExports = JSON.parse(
            run(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `const module = await import(${JSON.stringify(packageName)}); console.log(JSON.stringify(Object.keys(module).sort()))`,
                ],
                consumerDir,
            ),
        )
        const missingExports = expectedRuntimeExports.filter((name) => !importedExports.includes(name))
        if (missingExports.length > 0) {
            throw new Error(`The imported module is missing exports: ${missingExports.join(', ')}`)
        }
        console.log(`Imported exports: ${importedExports.join(', ')}`)
    })

    // skipLibCheck stays off so a relative specifier the consumer's TypeScript cannot follow fails here.
    runCheck('Type-checking a NodeNext consumer against the shipped declarations', () => {
        writeFileSync(
            join(consumerDir, 'tsconfig.json'),
            `${JSON.stringify(
                {
                    compilerOptions: {
                        target: 'esnext',
                        lib: ['esnext', 'dom', 'dom.iterable'],
                        module: 'nodenext',
                        moduleResolution: 'nodenext',
                        strict: true,
                        skipLibCheck: false,
                        noEmit: true,
                    },
                    include: ['consumer.ts'],
                },
                null,
                2,
            )}\n`,
        )
        writeFileSync(
            join(consumerDir, 'consumer.ts'),
            [
                `import { type MOSConfig, type MOSProxyLogger, MOSProxyBuilder } from ${JSON.stringify(packageName)}`,
                '',
                'export const builder = new MOSProxyBuilder()',
                'export const config: MOSConfig | null = null',
                'export const logger: MOSProxyLogger | undefined = undefined',
                '',
            ].join('\n'),
        )
        const tscVersion = run(binary('tsc'), ['--version'], consumerDir).trim()
        run(binary('tsc'), ['--project', 'tsconfig.json'], consumerDir, { showOutput: true })
        console.log(`Type-checked with tsc ${tscVersion}`)
    })
} catch (error) {
    failures.push(error.message)
} finally {
    rmSync(workDir, { recursive: true, force: true })
}

if (failures.length > 0) {
    console.error(`\nverify-package-resolution: ${packageName} does not resolve without a bundler\n`)
    console.error(failures.join('\n\n'))
    process.exit(1)
}

console.log(`\nverify-package-resolution: ${packageName} resolves from plain Node ${process.version} with no bundler.`)
