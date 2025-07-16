#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import { globSync } from 'glob';

/**
 * Extracts part of the changelog from the changelog file
 * for a specific version.
 */
function extractChangelogForVersion(changelogPath: string, version: string) {
  const content = readFileSync(changelogPath, 'utf8');
  const lines = content.split('\n');

  let inVersionSection = false;
  const releaseNotes = [];

  const escapeRegex = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  for (const line of lines) {
    // Look for version header (## 1.0.0 or ## [1.0.0])
    if (line.match(new RegExp(`^##\\s+\\[?${escapeRegex(version)}\\]?`))) {
      inVersionSection = true;
      continue;
    }

    // Stop when we hit the next version or end
    if (inVersionSection && line.match(/^##\s+/)) {
      break;
    }

    if (inVersionSection) {
      releaseNotes.push(line);
    }
  }

  return releaseNotes.join('\n').trim() || `Release ${version}`;
}

/**
 * Script to create GitHub releases for tagged packages.
 *
 * This script is intended to be run only in a GitHub Actions environment.
 * It extracts tags from the current commit and creates releases for each tagged package.
 */
export async function main() {
  try {
    // Get tags for the current commit first
    const currentCommit = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
    }).trim();
    const tagsOutput: string = execSync(
      `git tag --points-at ${currentCommit}`,
      {
        encoding: 'utf8',
      },
    ).trim();

    if (!tagsOutput) {
      core.info('No tags found for current commit - nothing to do.');
      return;
    }

    const tags = tagsOutput.split('\n').filter((tag) => tag.length > 0);
    core.info(`Found tags: ${tags}`);

    const token = core.getInput('token', { required: true });

    if (!token) {
      core.setFailed(
        'GITHUB_TOKEN is not set. This script must be run in a GitHub Actions environment with access to the token.',
      );
      return;
    }

    const octokit = getOctokit(token);

    core.info('Creating GitHub releases...');

    // Read root package.json to get workspace patterns
    const rootPackageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const workspaces = rootPackageJson.workspaces || [];

    core.info(`Workspace patterns: ${workspaces}`);

    // Find all package.json files in workspaces
    const packagePaths = [];

    for (const pattern of workspaces) {
      const packageJsonPattern = join(pattern, 'package.json');
      const matches = globSync(packageJsonPattern);
      packagePaths.push(...matches);
    }

    core.info(`Found packages: ${packagePaths}`);

    // Parse tags and match with packages
    for (const tag of tags) {
      core.info(`\nProcessing tag: ${tag}`);

      // Parse tag format: package-name@version
      const match = tag.match(/^(.+)@(.+)$/);

      if (!match) {
        core.info(`Skipping tag ${tag} - doesn't match package@version format`);
        continue;
      }

      const [, packageName, version] = match;
      core.info(`Parsed: package=${packageName}, version=${version}`);

      if (!version) {
        core.info(`Skipping tag ${tag} - no version found`);
        continue;
      }

      if (!packageName) {
        core.info(`Skipping tag ${tag} - no package name found`);
        continue;
      }

      // Find matching package
      const matchingPackage = packagePaths.find((packagePath) => {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
        return pkg.name === packageName && pkg.version === version;
      });

      if (!matchingPackage) {
        core.warning(`No matching package found for ${packageName}@${version}`);
        continue;
      }

      core.info(`Found matching package: ${matchingPackage}`);

      // Extract changelog for this version
      const packageDir = dirname(matchingPackage);
      const changelogPath = join(packageDir, 'CHANGELOG.md');

      let releaseNotes = '';
      if (existsSync(changelogPath)) {
        releaseNotes = extractChangelogForVersion(changelogPath, version);
        core.info(`Extracted changelog: ${releaseNotes.substring(0, 100)}...`);
      } else {
        core.info('No CHANGELOG.md found, using default release notes');
        releaseNotes = `Release ${version} of ${packageName}`;
      }

      // Create GitHub release
      try {
        const release = await octokit.rest.repos.createRelease({
          owner: context.repo.owner,
          repo: context.repo.repo,
          tag_name: tag,
          name: `${packageName}@${version}`,
          body: releaseNotes,
          draft: false,
          prerelease: /-(alpha|beta|rc|pre)/i.test(version),
        });

        core.info(`✅ Created release for ${tag}: ${release.data.html_url}`);
      } catch (error) {
        if (error instanceof Error) {
          if (
            'status' in error &&
            error.status === 422 &&
            error.message.includes('already_exists')
          ) {
            core.warning(`⚠️  Release for ${tag} already exists`);
          } else {
            core.error(
              `❌ Failed to create release for ${tag}: ${error.message}`,
            );
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Error creating releases: ${error.message}`);
    } else {
      core.setFailed(`Error creating releases: ${error}`);
    }
  }
}

main();
