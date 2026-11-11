#!/usr/bin/env node
/* global console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { isIsoDateString } from '../src/main/personal-update/contract.mjs';
import { readPersonalUpdatePolicy } from './ci/personal-update-metadata.mjs';
import { assertPackagedPersonalIdentity, createPersonalUpdateManifest, hashFile, personalReleaseAssets } from './ci/personal-update-artifacts.mjs';

/** Windows PowerShell 5.1 Compress-Archive writes `\` separators, so normalise before lookup. */
export async function readZipSourceMetadata(zipPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const matches = Object.values(zip.files).filter(entry => !entry.dir && entry.name.replaceAll('\\', '/') === 'resources/cindy-source.json');
  if (matches.length !== 1) throw new Error('Personal update ZIP must contain exactly one resources/cindy-source.json');
  return JSON.parse(await matches[0].async('string'));
}

export async function preparePersonalUpdate({ desktopRoot, artifactDir, appPath }) {
  const buildInfo = JSON.parse(fs.readFileSync(path.join(artifactDir, 'build-info.json'), 'utf8'));
  const policy = readPersonalUpdatePolicy(desktopRoot, buildInfo.platform, buildInfo.arch);
  const manifest = createPersonalUpdateManifest({ buildInfo, artifactDir, policy });
  const assets = personalReleaseAssets(policy);
  let sourceMetadata;
  if (manifest.platform === 'win32') {
    sourceMetadata = await readZipSourceMetadata(path.join(artifactDir, assets.zip));
  } else {
    if (!appPath) throw new Error('Usage: prepare-personal-update.mjs <artifacts> <unpacked-Cindy.app>');
    sourceMetadata = JSON.parse(fs.readFileSync(path.join(appPath, 'Contents/Resources/cindy-source.json'), 'utf8'));
  }
  assertPackagedPersonalIdentity(sourceMetadata, manifest, policy);
  // Optional display-only build time, taken from the packaged metadata so the feed and the installed app agree.
  const published = isIsoDateString(sourceMetadata.builtAt) ? { ...manifest, builtAt: sourceMetadata.builtAt } : manifest;
  fs.writeFileSync(path.join(artifactDir, 'personal-update.json'), `${JSON.stringify(published, null, 2)}\n`);
  const files = assets.files.filter(name => name !== 'SHA256SUMS');
  fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), files.map(name => `${hashFile(path.join(artifactDir, name))}  ${name}\n`).join(''));
  return published;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: prepare-personal-update.mjs <artifacts> [unpacked-Cindy.app (macOS only)]');
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await preparePersonalUpdate({ desktopRoot, artifactDir: path.resolve(process.argv[2]), appPath: process.argv[3] });
  console.log(`Verified personal update revision ${manifest.revision}, source ${manifest.sourceCommit}`);
}
