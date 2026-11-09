#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPersonalUpdatePolicy } from './ci/personal-update-metadata.mjs';
import { assertPackagedPersonalIdentity, createPersonalUpdateManifest, hashFile } from './ci/personal-update-artifacts.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.resolve(process.argv[2] ?? '');
const appPath = process.argv[3];
if (!process.argv[2] || !appPath) throw new Error('Usage: prepare-personal-update.mjs <artifacts> <unpacked-Cindy.app>');
const policy = readPersonalUpdatePolicy(desktopRoot);
const buildInfo = JSON.parse(fs.readFileSync(path.join(artifactDir, 'build-info.json'), 'utf8'));
const manifest = createPersonalUpdateManifest({ buildInfo, artifactDir, policy });
const sourceMetadata = JSON.parse(fs.readFileSync(path.join(appPath, 'Contents/Resources/cindy-source.json'), 'utf8'));
assertPackagedPersonalIdentity(sourceMetadata, manifest, policy);
fs.writeFileSync(path.join(artifactDir, 'personal-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const files = ['cindy-unversioned-arm64.zip', 'cindy-unversioned-arm64.dmg', 'build-info.json', 'personal-update.json'];
fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), files.map(name => `${hashFile(path.join(artifactDir, name))}  ${name}\n`).join(''));
console.log(`Verified personal update revision ${manifest.revision}, source ${manifest.sourceCommit}`);
