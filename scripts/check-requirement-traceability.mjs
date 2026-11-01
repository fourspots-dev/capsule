import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function checkRequirementTraceability(root = resolve(dirname(scriptPath), '..')) {
  const registryPath = join(root, 'policy/requirement-registry.json');
  const packagePath = join(root, 'package.json');
  const errors = [];
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const requirements = Array.isArray(registry.requirements)
    ? registry.requirements
    : [];
  const ids = new Set();
  const aliases = new Set();
  const requirementTypes = new Set([
    'feature',
    'bugfix',
    'security',
    'refactor',
    'infrastructure',
    'documentation',
  ]);
  const priorities = new Set(['P0', 'P1', 'P2', 'P3']);
  const statuses = new Set([
    'proposed',
    'accepted',
    'in_progress',
    'implemented',
    'verified',
    'released',
  ]);

  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!/^[a-f0-9]{7,40}$/.test(String(registry.baselineCommit))) {
    errors.push('baselineCommit must be a git commit id');
  }
  if (!isSemver(packageJson.version)) {
    errors.push(`package.json version is not A.B.C: ${packageJson.version}`);
  }

  for (const requirement of requirements) {
    const label = requirement?.id ?? '<missing-id>';
    if (!/^REQ-[A-Z][A-Z0-9]*-[0-9]{3,}$/.test(String(requirement?.id))) {
      errors.push(`${label}: invalid requirement id`);
    }
    if (ids.has(requirement?.id)) errors.push(`${label}: duplicate requirement id`);
    ids.add(requirement?.id);
    if (typeof requirement?.title !== 'string' || !requirement.title.trim()) {
      errors.push(`${label}: title is required`);
    }
    if (!requirementTypes.has(requirement?.type)) {
      errors.push(`${label}: invalid type ${requirement?.type}`);
    }
    if (!priorities.has(requirement?.priority)) {
      errors.push(`${label}: invalid priority ${requirement?.priority}`);
    }
    if (!statuses.has(requirement?.status)) {
      errors.push(`${label}: invalid status ${requirement?.status}`);
    }
    if (!isSemver(requirement?.targetVersion)) {
      errors.push(`${label}: invalid targetVersion ${requirement?.targetVersion}`);
    }
    if (typeof requirement?.acceptance !== 'string' || !requirement.acceptance.trim()) {
      errors.push(`${label}: acceptance is required`);
    }
    if (
      !Array.isArray(requirement?.legacyAliases) ||
      requirement.legacyAliases.some((alias) => typeof alias !== 'string')
    ) {
      errors.push(`${label}: legacyAliases must be an array of strings`);
    } else {
      for (const alias of requirement.legacyAliases) {
        if (aliases.has(alias)) errors.push(`${label}: duplicate legacy alias ${alias}`);
        aliases.add(alias);
      }
    }
    if (
      requirement.status !== 'proposed' &&
      requirement.status !== 'accepted'
    ) {
      requireDocument(requirement.design, `${label}: design`, root, errors);
      requireDocument(requirement.testDesign, `${label}: testDesign`, root, errors);
    }
    if (
      requirement.architectureImpact !== undefined &&
      typeof requirement.architectureImpact !== 'boolean'
    ) {
      errors.push(`${label}: architectureImpact must be a boolean`);
    }
    if (requirement.architectureImpact === true) {
      requireAnchor(
        requirement.design,
        'architecture-impact',
        `${label}: architecture-impact design anchor`,
        root,
        errors
      );
      requireAnchor(
        requirement.testDesign,
        'architecture-completeness',
        `${label}: architecture-completeness test anchor`,
        root,
        errors
      );
    }
  }

  return { errors, requirements, version: packageJson.version };
}

export function requireDocument(value, label, projectRoot, target = []) {
  if (typeof value !== 'string' || !value.trim()) {
    target.push(`${label} is required`);
    return;
  }
  const [pathname, anchor] = value.split('#');
  const absolute = resolve(projectRoot, pathname);
  const fromRoot = relative(projectRoot, absolute);
  if (
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot) ||
    !existsSync(absolute)
  ) {
    target.push(`${label} does not exist: ${pathname}`);
    return;
  }
  if (anchor) {
    const body = readFileSync(absolute, 'utf8');
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`id=["']${escaped}["']`).test(body)) {
      target.push(`${label} anchor does not exist: #${anchor}`);
    }
  }
}

export function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
    String(value)
  );
}

export function requireAnchor(value, anchor, label, projectRoot, target = []) {
  if (typeof value !== 'string' || !value.trim()) {
    target.push(`${label} is required`);
    return;
  }
  const [pathname] = value.split('#');
  const absolute = resolve(projectRoot, pathname);
  const fromRoot = relative(projectRoot, absolute);
  if (
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot) ||
    !existsSync(absolute)
  ) {
    target.push(`${label}: document does not exist: ${pathname}`);
    return;
  }
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !new RegExp(`id=["']${escaped}["']`).test(
      readFileSync(absolute, 'utf8')
    )
  ) {
    target.push(`${label}: section #${anchor} does not exist`);
  }
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  const result = checkRequirementTraceability();
  if (result.errors.length) {
    process.stderr.write(
      [
        'Requirement traceability check failed:',
        ...result.errors.map((error) => `- ${error}`),
      ].join('\n') + '\n'
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Requirement traceability OK: ${result.requirements.length} requirements, version ${result.version}\n`
    );
  }
}
