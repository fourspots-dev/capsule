import { describe, expect, it } from 'vitest';
import {
  settingsCard,
  settingsField,
  settingsForm,
  settingsGroup,
  settingsNavRow,
  settingsRow,
  settingsSelectRow,
  settingsSubpage,
} from '../../src/sidepanel/settings-components';

describe('REQ-UI-001 canonical settings components', () => {
  it('renders a canonical settings subpage with back navigation', () => {
    const html = settingsSubpage({
      title: 'Remote <Actions>',
      backAction: 'back-runtime',
      backLabel: 'Back',
      backIcon: '<svg></svg>',
      theme: 'dark',
      body: '<div id="body"></div>',
    });
    expect(html).toContain('id="kernel-page-layer"');
    expect(html).toContain('data-wb-theme="dark"');
    expect(html).toContain('data-page-action="back-runtime"');
    expect(html).toContain('Remote &lt;Actions&gt;');
    expect(html).toContain('<div class="wb-settings-body"><div id="body"></div></div>');
  });

  it('owns groups and cards instead of leaving visual markup to consumers', () => {
    const html = settingsGroup({
      label: 'Runtime',
      cardClassName: 'custom-card',
      content: settingsCard('row'),
    });
    expect(html).toContain('class="wb-set-group"');
    expect(html).toContain('class="wb-set-group-label">Runtime</div>');
    expect(html).toContain('class="wb-set-card custom-card"');
    expect(html).toContain('class="wb-set-card"');
  });

  it('renders static and navigate rows with canonical classes and escaping', () => {
    const staticRow = settingsRow({
      label: 'Version',
      icon: '<svg data-icon="version"></svg>',
      value: '0.11.0 <beta>',
    });
    expect(staticRow).toContain('<div class="wb-set-row">');
    expect(staticRow).toContain('class="wb-set-row-icon"');
    expect(staticRow).toContain('0.11.0 &lt;beta&gt;');

    const navRow = settingsNavRow({
      label: 'Capabilities',
      icon: '<svg></svg>',
      value: '1 available',
      action: 'capabilities',
    });
    expect(navRow).toContain('<button type="button"');
    expect(navRow).toContain('class="wb-set-row wb-set-navrow wb-clickable"');
    expect(navRow).toContain('data-page-action="capabilities"');
    expect(navRow).toContain('wb-set-select-chevron');
  });

  it('renders shared select and custom control rows', () => {
    const select = settingsSelectRow({
      label: 'Appearance',
      icon: '<svg></svg>',
      value: 'Light mode',
      action: 'theme',
    });
    expect(select).toContain('class="wb-set-row wb-set-selectrow"');
    expect(select).toContain('class="wb-set-select"');
    expect(select).toContain('data-page-action="theme"');

    const custom = settingsRow({
      label: 'Zoom',
      control: '<button data-page-action="zoom">100%</button>',
    });
    expect(custom).toContain('class="wb-input-grow"');
    expect(custom).toContain('data-page-action="zoom"');
  });

  it('renders canonical form fields and form shells', () => {
    const field = settingsField({
      label: 'Action <endpoint>',
      control: '<input id="endpoint" type="url">',
    });
    expect(field).toBe(
      '<label>Action &lt;endpoint&gt;<input id="endpoint" type="url"></label>'
    );
    const form = settingsForm({
      id: 'remote-form',
      className: 'extra',
      content: field,
    });
    expect(form).toContain('id="remote-form"');
    expect(form).toContain('class="wb-form extra"');
    expect(
      settingsField({
        label: 'Enable',
        control: '<input type="checkbox">',
        className: 'wb-row',
        controlFirst: true,
      })
    ).toBe('<label class="wb-row"><input type="checkbox">Enable</label>');
  });
});
