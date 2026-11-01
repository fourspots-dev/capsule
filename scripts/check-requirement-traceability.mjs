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
  const adrRegistry = JSON.parse(
    readFileSync(join(root, 'policy/adr-registry.json'), 'utf8')
  );
  const requirements = Array.isArray(registry.requirements)
    ? registry.requirements
    : [];
  const adrById = new Map(
    (adrRegistry.decisions ?? []).map((adr) => [adr.id, adr])
  );
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
  const designStatuses = new Set(['draft', 'review', 'approved']);
  const adrReviewStatuses = new Set([
    'pending',
    'existing',
    'proposed',
    'not_required',
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
    if (!designStatuses.has(requirement?.designStatus)) {
      errors.push(`${label}: invalid designStatus ${requirement?.designStatus}`);
    }
    if (typeof requirement?.implementationAuthorized !== 'boolean') {
      errors.push(`${label}: implementationAuthorized must be a boolean`);
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
    validateAdrReview(requirement, label, adrById, adrReviewStatuses, errors);
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
    if (
      ['in_progress', 'implemented', 'verified', 'released'].includes(
        requirement.status
      )
    ) {
      if (requirement.designStatus !== 'approved') {
        errors.push(
          `${label}: designStatus must be approved before ${requirement.status}`
        );
      }
      if (requirement.implementationAuthorized !== true) {
        errors.push(
          `${label}: implementationAuthorized must be true before ${requirement.status}`
        );
      }
    }
  }

  return { errors, requirements, version: packageJson.version };
}

function validateAdrReview(requirement, label, adrById, statuses, errors) {
  const required = isVersionAtLeast(requirement.targetVersion, 0, 5, 0);
  const review = requirement.adrReview;
  if (review === undefined) {
    if (required) {
      errors.push(`${label}: adrReview is required from targetVersion 0.5.0`);
    }
    return;
  }
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    errors.push(`${label}: adrReview must be an object`);
    return;
  }
  if (!statuses.has(review.status)) {
    errors.push(`${label}: invalid adrReview.status ${review.status}`);
  }
  if (
    !Array.isArray(review.adrs) ||
    review.adrs.some((id) => typeof id !== 'string')
  ) {
    errors.push(`${label}: adrReview.adrs must be an array of ADR ids`);
    return;
  }
  if (new Set(review.adrs).size !== review.adrs.length) {
    errors.push(`${label}: adrReview.adrs contains duplicate ids`);
  }
  if (typeof review.rationale !== 'string' || !review.rationale.trim()) {
    errors.push(`${label}: adrReview.rationale is required`);
  }
  if (
    typeof review.reviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt)
  ) {
    errors.push(`${label}: adrReview.reviewedAt must be YYYY-MM-DD`);
  }

  if (review.status === 'existing' || review.status === 'proposed') {
    if (review.adrs.length === 0) {
      errors.push(`${label}: ${review.status} adrReview requires an ADR`);
    }
    for (const adrId of review.adrs) {
      const adr = adrById.get(adrId);
      if (!adr) {
        errors.push(`${label}: adrReview references unknown ADR ${adrId}`);
        continue;
      }
      const expectedStatus =
        review.status === 'existing' ? 'accepted' : 'proposed';
      if (adr.status !== expectedStatus) {
        errors.push(
          `${label}: ${adrId} must be ${expectedStatus} for adrReview ${review.status}`
        );
      }
      if (!(adr.requirements ?? []).includes(requirement.id)) {
        errors.push(
          `${label}: ${adrId} does not list REQ ${requirement.id}`
        );
      }
    }
  }
  if (review.status === 'not_required' && review.adrs.length !== 0) {
    errors.push(`${label}: not_required adrReview must not list ADR ids`);
  }
  if (
    review.status === 'pending' &&
    (requirement.designStatus === 'review' ||
      requirement.designStatus === 'approved' ||
      ['in_progress', 'implemented', 'verified', 'released'].includes(
        requirement.status
      ))
  ) {
    errors.push(
      `${label}: pending adrReview blocks design review and implementation`
    );
  }
  if (
    review.status === 'proposed' &&
    (requirement.designStatus === 'approved' ||
      ['in_progress', 'implemented', 'verified', 'released'].includes(
        requirement.status
      ))
  ) {
    errors.push(
      `${label}: proposed ADR review blocks design approval and implementation`
    );
  }
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

export function isVersionAtLeast(value, major, minor, patch) {
  if (!isSemver(value)) return false;
  const [actualMajor, actualMinor, actualPatch] = String(value)
    .split('.')
    .map(Number);
  if (actualMajor !== major) return actualMajor > major;
  if (actualMinor !== minor) return actualMinor > minor;
  return actualPatch >= patch;
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
