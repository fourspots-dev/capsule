import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const statuses = new Set([
  'captured',
  'needs_clarification',
  'triaged',
  'promoted',
  'no_action',
  'withdrawn',
  'superseded',
]);
const sources = new Set(['discussion', 'request', 'review', 'incident']);
const dispositions = new Set([
  'adr',
  'requirement',
  'adr_and_requirement',
  'design_detail',
  'no_action',
]);
const requiredSections = [
  'Statement',
  'Normalized decision',
  'Rationale',
  'Promotion',
];

export function checkDecisionRegistry(root = resolve(dirname(scriptPath), '..')) {
  const errors = [];
  const registry = readJson(resolve(root, 'policy/decision-registry.json'));
  const requirementRegistry = readJson(
    resolve(root, 'policy/requirement-registry.json')
  );
  const adrRegistry = readJson(resolve(root, 'policy/adr-registry.json'));
  const requirementById = new Map(
    (requirementRegistry.requirements ?? []).map((requirement) => [
      requirement.id,
      requirement,
    ])
  );
  const adrById = new Map(
    (adrRegistry.decisions ?? []).map((adr) => [adr.id, adr])
  );

  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(registry.decisions)) {
    return { errors: [...errors, 'decisions must be an array'], decisions: [] };
  }

  const decisions = new Map();
  const registeredFiles = new Set();
  for (const decision of registry.decisions) {
    const label = decision?.id ?? '<missing-id>';
    if (!/^DEC-[0-9]{3,}$/.test(String(decision?.id))) {
      errors.push(`${label}: invalid DEC id`);
    }
    if (decisions.has(decision?.id)) {
      errors.push(`${label}: duplicate DEC id`);
    }
    decisions.set(decision?.id, decision);

    requireText(decision?.title, `${label}: title is required`, errors);
    requireText(decision?.statement, `${label}: statement is required`, errors);
    requireText(
      decision?.normalizedDecision,
      `${label}: normalizedDecision is required`,
      errors
    );
    if (!statuses.has(decision?.status)) {
      errors.push(`${label}: invalid status ${decision?.status}`);
    }
    if (!sources.has(decision?.source)) {
      errors.push(`${label}: invalid source ${decision?.source}`);
    }
    if (
      typeof decision?.capturedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(decision.capturedAt)
    ) {
      errors.push(`${label}: capturedAt must be YYYY-MM-DD`);
    }
    validateUniqueStringArray(
      decision?.scope,
      `${label}: scope`,
      errors,
      true
    );
    validateUniqueStringArray(
      decision?.supersedes,
      `${label}: supersedes`,
      errors,
      false
    );
    if (
      decision?.supersededBy !== null &&
      typeof decision?.supersededBy !== 'string'
    ) {
      errors.push(`${label}: supersededBy must be a DEC id or null`);
    }
    if (decision?.status === 'superseded') {
      if (!decision.supersededBy) {
        errors.push(`${label}: superseded DEC must set supersededBy`);
      }
    } else if (decision?.supersededBy !== null) {
      errors.push(`${label}: supersededBy is only valid for superseded status`);
    }
    validateTriage(decision, errors);

    const fileResult = loadDecisionFile(decision?.file, root);
    if (fileResult.error) {
      errors.push(`${label}: ${fileResult.error}`);
    } else {
      const body = fileResult.body;
      const normalizedFile = relative(root, resolve(root, decision.file))
        .split('\\')
        .join('/');
      registeredFiles.add(normalizedFile);
      if (
        !new RegExp(
          `^docs/decisions/${escapeRegex(String(decision.id))}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`
        ).test(normalizedFile)
      ) {
        errors.push(
          `${label}: file must use docs/decisions/${decision.id}-<kebab-slug>.md`
        );
      }
      if (
        registry.decisions.filter(
          (candidate) => candidate.file === decision.file
        ).length > 1
      ) {
        errors.push(`${label}: duplicate DEC file ${decision.file}`);
      }
      checkDocument(body, decision, errors);
    }
  }

  for (const decision of registry.decisions) {
    const triage = decision.triage;
    for (const adrId of triage?.adrs ?? []) {
      const adr = adrById.get(adrId);
      if (!adr) {
        errors.push(`${decision.id}: unknown ADR ${adrId}`);
      } else if (adr.originDecision !== decision.id) {
        errors.push(
          `${decision.id}: ${adrId} does not point back with originDecision`
        );
      }
    }
    for (const requirementId of triage?.requirements ?? []) {
      if (!requirementById.has(requirementId)) {
        errors.push(`${decision.id}: unknown requirement ${requirementId}`);
      }
    }
    if (decision.supersededBy) {
      const replacement = decisions.get(decision.supersededBy);
      if (!replacement) {
        errors.push(
          `${decision.id}: supersededBy unknown DEC ${decision.supersededBy}`
        );
      } else if (!(replacement.supersedes ?? []).includes(decision.id)) {
        errors.push(
          `${decision.id}: replacement ${decision.supersededBy} does not list Supersedes`
        );
      }
    }
    for (const supersededId of decision.supersedes ?? []) {
      if (supersededId === decision.id) {
        errors.push(`${decision.id}: DEC cannot supersede itself`);
        continue;
      }
      const superseded = decisions.get(supersededId);
      if (!superseded) {
        errors.push(`${decision.id}: supersedes unknown DEC ${supersededId}`);
      } else if (superseded.supersededBy !== decision.id) {
        errors.push(
          `${decision.id}: ${supersededId} does not point back with supersededBy`
        );
      } else if (superseded.status !== 'superseded') {
        errors.push(
          `${decision.id}: superseded target ${supersededId} must have status superseded`
        );
      }
    }
  }

  detectCycles(registry.decisions, errors);
  checkRegisteredFileSet(registeredFiles, root, errors);
  return { errors, decisions: registry.decisions };
}

function validateTriage(decision, errors) {
  const label = decision.id ?? '<missing-id>';
  const triage = decision.triage;
  const status = decision.status;
  const needsTriage = ['triaged', 'promoted', 'no_action'].includes(status);
  if (!needsTriage) {
    if (triage !== null && triage !== undefined) validateTriageShape(triage, label, errors);
    return;
  }
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) {
    errors.push(`${label}: ${status} DEC requires triage`);
    return;
  }
  validateTriageShape(triage, label, errors);
  requireText(triage.rationale, `${label}: triage rationale is required`, errors);
  if (!dispositions.has(triage.disposition)) {
    errors.push(`${label}: invalid triage disposition ${triage.disposition}`);
  }

  const adrs = Array.isArray(triage.adrs) ? triage.adrs : [];
  const requirements = Array.isArray(triage.requirements)
    ? triage.requirements
    : [];
  if (
    ['adr', 'adr_and_requirement'].includes(triage.disposition) &&
    adrs.length === 0
  ) {
    errors.push(`${label}: ${triage.disposition} requires at least one ADR`);
  }
  if (
    ['requirement', 'design_detail', 'adr_and_requirement'].includes(
      triage.disposition
    ) &&
    requirements.length === 0
  ) {
    errors.push(
      `${label}: ${triage.disposition} requires at least one requirement`
    );
  }
  if (triage.disposition === 'no_action') {
    if (adrs.length || requirements.length) {
      errors.push(`${label}: no_action triage cannot link ADR or REQ ids`);
    }
  }
  if (
    status === 'promoted' &&
    triage.disposition === 'no_action'
  ) {
    errors.push(`${label}: no_action DEC cannot have promoted status`);
  }
}

function validateTriageShape(triage, label, errors) {
  if (typeof triage !== 'object' || triage === null || Array.isArray(triage)) {
    errors.push(`${label}: triage must be an object`);
    return;
  }
  validateUniqueStringArray(triage.adrs, `${label}: triage.adrs`, errors, false);
  validateUniqueStringArray(
    triage.requirements,
    `${label}: triage.requirements`,
    errors,
    false
  );
}

function checkDocument(body, decision, errors) {
  const label = decision.id;
  const title = body.match(/^#\s+(DEC-[0-9]{3,}):\s+(.+)$/m);
  if (!title) {
    errors.push(`${label}: file title is missing or malformed`);
  } else {
    if (title[1] !== decision.id) {
      errors.push(`${label}: file id ${title[1]} does not match registry`);
    }
    if (title[2].trim() !== decision.title) {
      errors.push(`${label}: file title does not match registry`);
    }
  }
  for (const section of requiredSections) {
    if (!new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm').test(body)) {
      errors.push(`${label}: missing section ${section}`);
    }
  }

  compareField(body, 'Status', decision.status, label, errors);
  compareField(body, 'Captured', decision.capturedAt, label, errors);
  compareField(body, 'Source', decision.source, label, errors);
  compareList(body, 'Scope', decision.scope ?? [], label, errors);
  compareField(
    body,
    'Triage',
    decision.triage?.disposition ?? 'pending',
    label,
    errors
  );
  compareList(
    body,
    'ADRs',
    decision.triage?.adrs ?? [],
    label,
    errors
  );
  compareList(
    body,
    'Requirements',
    decision.triage?.requirements ?? [],
    label,
    errors
  );
  compareList(
    body,
    'Supersedes',
    decision.supersedes ?? [],
    label,
    errors
  );
  compareField(
    body,
    'Superseded by',
    decision.supersededBy ?? 'none',
    label,
    errors
  );
}

function compareField(body, name, expected, label, errors) {
  if (readField(body, name) !== expected) {
    errors.push(`${label}: file ${name} does not match registry`);
  }
}

function compareList(body, name, expected, label, errors) {
  if (!sameSet(readListField(body, name), expected)) {
    errors.push(`${label}: file ${name} does not match registry`);
  }
}

function readField(body, name) {
  return body.match(
    new RegExp(`^-\\s+${escapeRegex(name)}:\\s*(.*)$`, 'm')
  )?.[1]?.trim();
}

function readListField(body, name) {
  const value = readField(body, name);
  if (!value || value === 'none' || value === 'pending') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return (
    actualSet.size === actual.length &&
    expected.every((item) => actualSet.has(item))
  );
}

function validateUniqueStringArray(value, label, errors, requireValue) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${label} must be an array of strings`);
    return;
  }
  if (requireValue && value.length === 0) {
    errors.push(`${label} must not be empty`);
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${label} contains duplicate values`);
  }
}

function requireText(value, error, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(error);
}

function checkRegisteredFileSet(registeredFiles, root, errors) {
  const directory = resolve(root, 'docs/decisions');
  if (!existsSync(directory)) {
    errors.push('docs/decisions directory is missing');
    return;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^DEC-.*\.md$/.test(entry.name)) continue;
    const file = `docs/decisions/${entry.name}`;
    if (!registeredFiles.has(file)) {
      errors.push(`unregistered DEC file: ${file}`);
    }
  }
}

function loadDecisionFile(file, root) {
  if (typeof file !== 'string' || !file.trim()) {
    return { error: 'file is required' };
  }
  const absolute = resolve(root, file);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || !existsSync(absolute)) {
    return { error: `file does not exist: ${file}` };
  }
  return { body: readFileSync(absolute, 'utf8') };
}

function detectCycles(decisions, errors) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, path) => {
    if (visiting.has(id)) {
      errors.push(`DEC supersedes cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id)?.supersedes ?? []) {
      if (byId.has(next)) visit(next, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const decision of decisions) visit(decision.id, []);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  const result = checkDecisionRegistry();
  if (result.errors.length) {
    process.stderr.write(
      [
        'Decision registry check failed:',
        ...result.errors.map((error) => `- ${error}`),
      ].join('\n') + '\n'
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Decision registry OK: ${result.decisions.length} decisions\n`
    );
  }
}
