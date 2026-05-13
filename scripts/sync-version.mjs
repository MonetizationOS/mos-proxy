#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const target = resolve(root, 'src/apiRequestHeaders.ts')

const source = readFileSync(target, 'utf8')
const pattern = /export const MOS_PROXY_PACKAGE_VERSION = '[^']*'/
const replacement = `export const MOS_PROXY_PACKAGE_VERSION = '${pkg.version}'`

if (!pattern.test(source)) {
    console.error(`sync-version: could not find MOS_PROXY_PACKAGE_VERSION assignment in ${target}`)
    process.exit(1)
}

const updated = source.replace(pattern, replacement)

if (!updated.includes(replacement)) {
    console.error('sync-version: failed to update MOS_PROXY_PACKAGE_VERSION')
    process.exit(1)
}

writeFileSync(target, updated)
console.log(`sync-version: MOS_PROXY_PACKAGE_VERSION = ${pkg.version}`)
