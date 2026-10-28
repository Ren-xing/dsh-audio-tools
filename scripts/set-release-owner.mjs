#!/usr/bin/env node
// Fill the GitHub owner into package.json, the market submission template and
// the README. Run once, after the repository exists:
//
//   node scripts/set-release-owner.mjs <github-user> [repo-name]
//
// Idempotent: running it again with the same values changes nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[set-release-owner] ${message}`)
  process.exit(1)
}

const owner = process.argv[2]
const repo = process.argv[3] ?? 'dsh-audio-tools'
if (!owner) fail('usage: node scripts/set-release-owner.mjs <github-user> [repo-name]')
if (!/^[A-Za-z0-9-]+$/.test(owner)) fail(`"${owner}" does not look like a GitHub user/org name`)
if (!/^[A-Za-z0-9._-]+$/.test(repo)) fail(`"${repo}" does not look like a repository name`)

const website = `https://github.com/${owner}/${repo}`

// package.json -----------------------------------------------------------------
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.repository = { type: 'git', url: `git+${website}.git` }
pkg.homepage = `${website}#readme`
pkg.bugs = { url: `${website}/issues` }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// market submission ------------------------------------------------------------
const marketPath = join(ROOT, 'market', 'awesome-dsh-plugin.yml')
let market = readFileSync(marketPath, 'utf8')
market = market.replace(/^url: .*$/m, `url: ${website}`)
market = market.replace(/^name: .*$/m, `name: ${owner}/${repo}`)
writeFileSync(marketPath, market)

// README link -------------------------------------------------------------------
const readmePath = join(ROOT, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
const eol = readme.includes('\r\n') ? '\r\n' : '\n'
const marker = '<!-- repo-link -->'
const block = `${marker}${eol}> 源码与问题反馈：${website}${eol}${eol}`
let nextReadme
if (readme.includes(marker)) {
  nextReadme = readme.replace(
    new RegExp(`${marker}\\r?\\n[^\\r\\n]*\\r?\\n?`),
    block,
  )
} else {
  // Insert after the title block; handles both LF and CRLF files.
  const match = /\r?\n\r?\n/.exec(readme)
  nextReadme = match
    ? `${readme.slice(0, match.index + match[0].length)}${block}${readme.slice(match.index + match[0].length)}`
    : `${readme}${eol}${eol}${block}`
}
if (nextReadme !== readme) writeFileSync(readmePath, nextReadme)

console.log(`[set-release-owner] owner=${owner} repo=${repo}`)
console.log(`  package.json: ${pkg.repository.url}`)
console.log(`  market/awesome-dsh-plugin.yml: ${owner}/${repo}`)
console.log('\nNext:')
console.log(`  git remote add origin ${website}.git`)
console.log('  git push -u origin main')
console.log('  # add the repository topic "dsh-plugin" on GitHub')
