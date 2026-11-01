import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const statuses = new Set([
  'proposed',
  'accepted',
  'rejected',
  'superseded',
  'deprecated',
]);
const requiredSections = [
  'Context',
  'Decision',
  'Invariants',
  'Alternatives considered',
  'Consequences',
  'Affected surfaces',
  'Verification',
];

export function checkAdrRegistry(root = resolve(dirname(scriptPath), '..')) {
  const errors = [];
  const registryPath = resolve(root, 'policy/adr-registry.json');
  const requirementsPath = resolve(root, 'policy/requirement-registry.json');
  const decisionRegistryPath = resolve(root, 'policy/decision-registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const requirementRegistry = JSON.parse(
    readFileSync(requirementsPath, 'utf8')
  );
  const decisionRegistry = JSON.parse(
    readFileSync(decisionRegistryPath, 'utf8')
  );
  const requirementIds = new Set(
    (requirementRegistry.requirements ?? []).map((requirement) => requirement.id)
  );
  const decisionIds = new Set(
    (decisionRegistry.decisions ?? []).map((decision) => decision.id)
  );
  const decisionById = new Map(
    (decisionRegistry.decisions ?? []).map((decision) => [
      decision.id,
      decision,
    ])
  );
  if (registry.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(registry.decisions)) {
    return { errors: [...errors, 'decisions must be an array'], decisions: [] };
  }

  const decisions = new Map();
  const registeredFiles = new Set();
  for (const decision of registry.decisions) {
    const label = decision?.id ?? '<missing-id>';
    if (!/^ADR-[0-9]{3,}$/.test(String(decision?.id))) {
      errors.push(`${label}: invalid ADR id`);
    }
    if (decisions.has(decision?.id)) {
      errors.push(`${label}: duplicate ADR id`);
    }
    decisions.set(decision?.id, decision);
    if (typeof decision?.title !== 'string' || !decision.title.trim()) {
      errors.push(`${label}: title is required`);
    }
    if (!statuses.has(decision?.status)) {
      errors.push(`${label}: invalid status ${decision?.status}`);
    }
    if (!Array.isArray(decision?.requirements)) {
      errors.push(`${label}: requirements must be an array`);
    } else {
      if (new Set(decision.requirements).size !== decision.requirements.length) {
        errors.push(`${label}: requirements contains duplicate ids`);
      }
      for (const requirementId of decision.requirements) {
        if (!requirementIds.has(requirementId)) {
          errors.push(`${label}: unknown requirement ${requirementId}`);
        }
      }
    }
    if (
      decision?.originDecision !== null &&
      typeof decision?.originDecision !== 'string'
    ) {
      errors.push(`${label}: originDecision must be a DEC id or null`);
    } else if (
      decision?.originDecision &&
      !decisionIds.has(decision.originDecision)
    ) {
      errors.push(
        `${label}: unknown origin decision ${decision.originDecision}`
      );
    } else if (
      decision?.originDecision &&
      !(decisionById.get(decision.originDecision)?.triage?.adrs ?? []).includes(
        decision.id
      )
    ) {
      errors.push(
        `${label}: origin decision ${decision.originDecision} does not list this ADR`
      );
    }
    if (
      Array.isArray(decision?.requirements) &&
      decision.requirements.length === 0 &&
      !decision.originDecision
    ) {
      errors.push(
        `${label}: ADR requires at least one requirement or originDecision`
      );
    }
    if (
      !Array.isArray(decision?.supersedes) ||
      decision.supersedes.some((id) => typeof id !== 'string')
    ) {
      errors.push(`${label}: supersedes must be an array of ADR ids`);
    } else if (
      new Set(decision.supersedes).size !== decision.supersedes.length
    ) {
      errors.push(`${label}: supersedes contains duplicate ids`);
    }
    if (
      decision?.supersededBy !== null &&
      typeof decision?.supersededBy !== 'string'
    ) {
      errors.push(`${label}: supersededBy must be an ADR id or null`);
    }
    if (decision.status !== 'proposed') {
      if (
        typeof decision.decidedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(decision.decidedAt)
      ) {
        errors.push(`${label}: decidedAt must be YYYY-MM-DD`);
      }
      if (
        typeof decision.approvedBy !== 'string' ||
        !decision.approvedBy.trim() ||
        decision.approvedBy !== 'user'
      ) {
        errors.push(
          `${label}: non-proposed ADR requires approvedBy "user"`
        );
      }
    } else if (
      decision.approvedBy !== undefined &&
      decision.approvedBy !== null &&
      decision.approvedBy !== 'none'
    ) {
      errors.push(`${label}: proposed ADR must not record approval`);
    }
    if (decision.status === 'superseded') {
      if (!decision.supersededBy) {
        errors.push(`${label}: superseded ADR must set supersededBy`);
      }
    } else if (decision.supersededBy !== null) {
      errors.push(`${label}: supersededBy is only valid for superseded status`);
    }

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
          `^docs/adr/${escapeRegex(String(decision.id))}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`
        ).test(normalizedFile)
      ) {
        errors.push(
          `${label}: file must use docs/adr/${decision.id}-<kebab-slug>.md`
        );
      }
      const duplicateFileCount = registry.decisions.filter(
        (candidate) => candidate.file === decision.file
      ).length;
      if (duplicateFileCount > 1) {
        errors.push(`${label}: duplicate ADR file ${decision.file}`);
      }
      const title = body.match(/^#\s+(ADR-[0-9]{3,}):\s+(.+)$/m);
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
      const fileStatus = body.match(/^-\s+Status:\s+(\w+)$/m)?.[1];
      if (fileStatus !== decision.status) {
        errors.push(
          `${label}: file status ${fileStatus ?? '<missing>'} does not match registry`
        );
      }
      for (const section of requiredSections) {
        if (!new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm').test(body)) {
          errors.push(`${label}: missing section ${section}`);
        }
      }
      checkMetadata(body, decision, errors);
    }
  }

  for (const decision of registry.decisions) {
    for (const supersededId of decision.supersedes ?? []) {
      if (supersededId === decision.id) {
        errors.push(`${decision.id}: ADR cannot supersede itself`);
        continue;
      }
      const superseded = decisions.get(supersededId);
      if (!superseded) {
        errors.push(`${decision.id}: supersedes unknown ADR ${supersededId}`);
      } else if (superseded.supersededBy !== decision.id) {
        errors.push(
          `${decision.id}: ${supersededId} does not point back via supersededBy`
        );
      } else if (superseded.status !== 'superseded') {
        errors.push(
          `${decision.id}: superseded target ${supersededId} must have status superseded`
        );
      }
      if (decision.status !== 'accepted') {
        errors.push(
          `${decision.id}: only an accepted ADR may supersede another decision`
        );
      }
    }
    if (decision.supersededBy) {
      const replacement = decisions.get(decision.supersededBy);
      if (!replacement) {
        errors.push(
          `${decision.id}: supersededBy unknown ADR ${decision.supersededBy}`
        );
      } else if (!(replacement.supersedes ?? []).includes(decision.id)) {
        errors.push(
          `${decision.id}: replacement ${decision.supersededBy} does not list Supersedes`
        );
      } else if (!['accepted', 'superseded'].includes(replacement.status)) {
        errors.push(
          `${decision.id}: replacement ${decision.supersededBy} must be accepted or superseded`
        );
      }
    }
  }
  detectCycles(registry.decisions, errors);
  checkRegisteredFileSet(registeredFiles, root, errors);
  return { errors, decisions: registry.decisions };
}

function checkMetadata(body, decision, errors) {
  const label = decision.id;
  const date = readField(body, 'Date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push(`${label}: file Date must be YYYY-MM-DD`);
  } else if (decision.decidedAt && date !== decision.decidedAt) {
    errors.push(`${label}: file Date does not match registry decidedAt`);
  }

  const approval = readField(body, 'Approved by');
  const expectedApproval =
    decision.status === 'proposed' ? 'none' : decision.approvedBy;
  if (approval !== expectedApproval) {
    errors.push(`${label}: file Approved by does not match registry`);
  }

  const requirements = readListField(body, 'Requirements');
  if (!sameSet(requirements, decision.requirements ?? [])) {
    errors.push(`${label}: file Requirements do not match registry`);
  }

  const originDecision = readField(body, 'Origin decision');
  const expectedOrigin = decision.originDecision ?? 'none';
  if (originDecision !== expectedOrigin) {
    errors.push(`${label}: file Origin decision does not match registry`);
  }

  const supersedes = readListField(body, 'Supersedes');
  if (!sameSet(supersedes, decision.supersedes ?? [])) {
    errors.push(`${label}: file Supersedes do not match registry`);
  }

  const supersededBy = readField(body, 'Superseded by');
  const expectedReplacement = decision.supersededBy ?? 'none';
  if (supersededBy !== expectedReplacement) {
    errors.push(`${label}: file Superseded by does not match registry`);
  }
}

function readField(body, name) {
  return body.match(
    new RegExp(`^-\\s+${escapeRegex(name)}:\\s*(.*)$`, 'm')
  )?.[1]?.trim();
}

function readListField(body, name) {
  const value = readField(body, name);
  if (!value || value === 'none') return [];
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

function checkRegisteredFileSet(registeredFiles, root, errors) {
  const adrDirectory = resolve(root, 'docs/adr');
  if (!existsSync(adrDirectory)) {
    errors.push('docs/adr directory is missing');
    return;
  }
  for (const entry of readdirSync(adrDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ADR-.*\.md$/.test(entry.name)) continue;
    const file = `docs/adr/${entry.name}`;
    if (!registeredFiles.has(file)) {
      errors.push(`unregistered ADR file: ${file}`);
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
      errors.push(`ADR supersedes cycle: ${[...path, id].join(' -> ')}`);
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  const result = checkAdrRegistry();
  if (result.errors.length) {
    process.stderr.write(
      [
        'ADR registry check failed:',
        ...result.errors.map((error) => `- ${error}`),
      ].join('\n') + '\n'
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `ADR registry OK: ${result.decisions.length} decisions\n`
    );
  }
}
