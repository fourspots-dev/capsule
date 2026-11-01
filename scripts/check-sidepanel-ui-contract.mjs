import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const contractPath = 'docs/ui/tinyai-sidepanel-ui-contract.md';
const componentPath = 'src/sidepanel/settings-components.ts';
const panelPath = 'src/sidepanel/kernel-panel.ts';
const requiredContractSections = [
  '## Canonical components',
  '## Navigation',
  '## Form controls',
  '## Responsive requirements',
  '## Prohibited patterns',
  '## Evidence required for UI changes',
];
const requiredTemplates = [
  'docs/requirements/requirement-template.md',
  'docs/requirements/architecture-change-contract.md',
  'docs/requirements/design-template.html',
  'docs/requirements/testing-template.html',
];
const errors = [];

const contract = readRequired(contractPath);
for (const section of requiredContractSections) {
  if (!contract.includes(section)) {
    errors.push(`${contractPath}: missing section ${section}`);
  }
}
for (const template of requiredTemplates) {
  const body = readRequired(template);
  if (!/UI impact/i.test(body)) {
    errors.push(`${template}: missing UI impact intake`);
  }
  if (!body.includes('docs/ui/tinyai-sidepanel-ui-contract.md') &&
      !body.includes('../ui/tinyai-sidepanel-ui-contract.md')) {
    errors.push(`${template}: missing UI Contract link`);
  }
}

const components = readRequired(componentPath);
for (const primitive of [
  'settingsSubpage',
  'settingsGroup',
  'settingsCard',
  'settingsRow',
  'settingsNavRow',
  'settingsSelectRow',
  'settingsField',
  'settingsForm',
  'settingsSeparator',
]) {
  if (!new RegExp(`export function ${primitive}\\(`).test(components)) {
    errors.push(`${componentPath}: missing canonical primitive ${primitive}`);
  }
}

const panel = readRequired(panelPath);
if (!panel.includes("from './settings-components'")) {
  errors.push(`${panelPath}: must import the canonical settings components`);
}
const rawSettings =
  /class=["'][^"']*\bwb-(?:set-(?:card|group|row)|settings-(?:head|body))\b/;
if (rawSettings.test(panel)) {
  errors.push(
    `${panelPath}: raw Settings structure detected; compose ${componentPath} instead (see ${contractPath})`
  );
}
if (/<form[^>]*class=["'][^"']*\bwb-form\b/.test(panel)) {
  errors.push(
    `${panelPath}: raw Settings form detected; use settingsForm (see ${contractPath})`
  );
}

if (errors.length) {
  process.stderr.write(
    `Side Panel UI contract check failed:\n${errors
      .map((error) => `- ${error}`)
      .join('\n')}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Side Panel UI contract OK: canonical components and UI impact intake are intact.\n`
  );
}

function readRequired(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    errors.push(`${path}: required file is missing`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}
